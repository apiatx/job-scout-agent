/**
 * Link Validator & Canonical URL Resolver
 *
 * Validates job posting URLs and resolves them to the best available
 * canonical source using a deterministic source-trust hierarchy.
 * For broken links on worthwhile jobs, Gemini grounded search finds
 * the live canonical posting.
 *
 * Source trust hierarchy (highest → lowest):
 *   ats_direct     → Greenhouse / Lever / Ashby / Workday / known ATS platforms
 *   company_career → Company's own domain under /careers, /jobs, /positions
 *   aggregator     → LinkedIn / Indeed / Glassdoor / ZipRecruiter
 *   unknown        → Anything else
 *
 * Link confidence levels:
 *   high    → url_ok=true AND (ats_direct | company_career) — safest to show
 *   medium  → url_ok=true AND aggregator | url_ok=null AND ats_direct
 *   low     → url_ok=false (broken) | url_ok=null AND aggregator
 *   unknown → url_ok=null AND unknown domain
 */

import { GoogleGenAI } from '@google/genai';
import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SourceTrust   = 'ats_direct' | 'company_career' | 'aggregator' | 'unknown';
export type LinkConfidence = 'high' | 'medium' | 'low' | 'unknown';

export interface CanonicalResolutionResult {
  canonicalUrl:    string;
  canonicalSource: string;   // 'ats_direct' | 'company_career' | 'aggregator' | 'gemini_resolved' | 'original'
  linkConfidence:  LinkConfidence;
  wasResolvedByGemini: boolean;
  validationNotes?: string;
}

// ── Domain lists ──────────────────────────────────────────────────────────────

const ATS_DOMAINS: string[] = [
  'boards.greenhouse.io',
  'job-boards.greenhouse.io',
  'jobs.greenhouse.io',
  'jobs.lever.co',
  'hire.lever.co',
  'jobs.ashbyhq.com',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'jobs.jobvite.com',
  'apply.workable.com',
  'smartrecruiters.com',
  'recruiting.paylocity.com',
  'jobs.icims.com',
  'bamboohr.com',
  'jobs.rippling.com',
  'grnh.se',               // Greenhouse short link
  'lnkd.in',              // LinkedIn short — treated as ATS redirect
];

const AGGREGATOR_DOMAINS: string[] = [
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'monster.com',
  'careerbuilder.com',
  'dice.com',
  'simplyhired.com',
  'jobs.com',
  'built.io',
  'builtinnyc.com',
  'builtinsf.com',
  'builtinchicago.com',
  'builtin.com',
];

// Paths that indicate a direct company career page
const CAREER_PATH_PATTERNS = [
  '/careers/',
  '/careers#',
  '/jobs/',
  '/openings/',
  '/positions/',
  '/apply/',
  '/job/',
];

// ── Source trust scoring ──────────────────────────────────────────────────────

export function classifySourceTrust(url: string): SourceTrust {
  if (!url) return 'unknown';
  const lower = url.toLowerCase();
  if (ATS_DOMAINS.some(d => lower.includes(d))) return 'ats_direct';
  if (AGGREGATOR_DOMAINS.some(d => lower.includes(d))) return 'aggregator';
  // Company career page: direct domain + career-ish path
  if (CAREER_PATH_PATTERNS.some(p => lower.includes(p))) return 'company_career';
  return 'unknown';
}

// ── Confidence scoring ─────────────────────────────────────────────────────────

export function computeLinkConfidence(
  url: string,
  urlOk: boolean | null,
  wasResolvedByGemini = false,
): LinkConfidence {
  const trust = classifySourceTrust(url);

  // Gemini successfully resolved and verified a live URL
  if (wasResolvedByGemini && urlOk !== false) return 'high';

  if (urlOk === true) {
    if (trust === 'ats_direct' || trust === 'company_career') return 'high';
    return 'medium'; // aggregator or unknown but confirmed live
  }

  if (urlOk === false) return 'low';

  // urlOk = null (not yet checked)
  if (trust === 'ats_direct' || trust === 'company_career') return 'medium';
  if (trust === 'aggregator') return 'low';
  return 'unknown';
}

// ── Gemini URL resolver ───────────────────────────────────────────────────────

/**
 * Uses Gemini grounded search to find the canonical live posting URL for a job.
 * Only called when url_ok=false and the job is worth rescuing (score ≥ threshold).
 * Returns null if Gemini is unconfigured or no live URL is found.
 */
export async function resolveJobUrlWithGemini(
  title: string,
  company: string,
  location: string,
): Promise<{ url: string; source: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3-flash-preview';

  // Focused queries in descending specificity
  const queries = [
    `"${company}" "${title}" site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com`,
    `"${company}" "${title}" job opening current hiring careers page`,
    `${company} "${title}" ${location} apply now`,
  ];

  const prompt = `
You are a job search assistant. Find the current, live job posting URL for this role:

Job Title: "${title}"
Company: "${company}"
Location: "${location || 'US'}"

Search for the real application page. Prefer direct company/ATS links in this order:
1. boards.greenhouse.io / jobs.lever.co / jobs.ashbyhq.com / myworkdayjobs.com
2. The company's own careers page
3. A reliable job board only as a last resort

Return ONLY the single best URL you find, with no other text.
If you cannot find a live active posting, return exactly: NOT_FOUND
`.trim();

  for (const q of queries) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: prompt + `\n\nSearch query to use: ${q}` }] }],
        config: { tools: [{ googleSearch: {} }], temperature: 0 },
      });

      const text = (response.text ?? '').trim();
      if (!text || text === 'NOT_FOUND') continue;

      // Extract the first URL from the response
      const urlMatch = text.match(/https?:\/\/[^\s\n"'<>()\],;]+/);
      if (!urlMatch) continue;
      const candidateUrl = urlMatch[0].replace(/[.,;!?)]+$/, '');

      // Skip if it points back to an aggregator (not a canonical source)
      const trust = classifySourceTrust(candidateUrl);
      if (trust === 'aggregator') continue;

      // Quick liveness check
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 6000);
        const res = await fetch(candidateUrl, {
          method: 'HEAD',
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobScout/1.0)' },
        });
        clearTimeout(timer);
        if (res.status < 400) {
          const sourceLabel = trust === 'ats_direct' ? 'gemini_resolved_ats'
            : trust === 'company_career'              ? 'gemini_resolved_company'
            :                                           'gemini_resolved';
          return { url: candidateUrl, source: sourceLabel };
        }
      } catch {
        // URL didn't respond — try next query
      }
    } catch (e) {
      // Gemini call failed (rate limit, timeout, etc.) — abort remaining queries
      console.warn(`[LinkValidator] Gemini resolution failed: ${e instanceof Error ? e.message : e}`);
      break;
    }
  }
  return null;
}

// ── Batch canonical resolution ────────────────────────────────────────────────

/**
 * Background task: for each job where url_ok=false AND score is worth rescuing,
 * attempt Gemini resolution. Also stamps link_confidence for all jobs that lack it.
 *
 * Never blocks the pipeline — call with .catch(() => {}).
 */
export async function runCanonicalResolutionInBackground(
  pool: Pool,
  jobIds?: number[],
): Promise<void> {
  try {
    // ── Step 1: Stamp link_confidence for all jobs that don't have one yet ──
    await pool.query(`
      UPDATE jobs
      SET link_confidence = CASE
        WHEN url_ok = true  AND (
          apply_url ILIKE '%boards.greenhouse.io%' OR
          apply_url ILIKE '%job-boards.greenhouse.io%' OR
          apply_url ILIKE '%jobs.lever.co%' OR
          apply_url ILIKE '%hire.lever.co%' OR
          apply_url ILIKE '%jobs.ashbyhq.com%' OR
          apply_url ILIKE '%ashbyhq.com%' OR
          apply_url ILIKE '%myworkdayjobs.com%' OR
          apply_url ILIKE '%jobs.jobvite.com%' OR
          apply_url ILIKE '%bamboohr.com%' OR
          apply_url ILIKE '%smartrecruiters.com%' OR
          apply_url ILIKE '%apply.workable.com%' OR
          apply_url ILIKE '/careers/' OR apply_url ILIKE '/jobs/'
        ) THEN 'high'
        WHEN url_ok = true  THEN 'medium'
        WHEN url_ok = false THEN 'low'
        WHEN (
          apply_url ILIKE '%boards.greenhouse.io%' OR
          apply_url ILIKE '%job-boards.greenhouse.io%' OR
          apply_url ILIKE '%jobs.lever.co%' OR
          apply_url ILIKE '%jobs.ashbyhq.com%' OR
          apply_url ILIKE '%myworkdayjobs.com%'
        ) THEN 'medium'
        WHEN (
          apply_url ILIKE '%linkedin.com%' OR
          apply_url ILIKE '%indeed.com%' OR
          apply_url ILIKE '%glassdoor.com%' OR
          apply_url ILIKE '%ziprecruiter.com%'
        ) THEN 'low'
        ELSE 'unknown'
      END,
      canonical_url    = COALESCE(canonical_url, apply_url),
      canonical_source = COALESCE(canonical_source, CASE
        WHEN apply_url ILIKE '%boards.greenhouse.io%' OR
             apply_url ILIKE '%job-boards.greenhouse.io%' OR
             apply_url ILIKE '%jobs.lever.co%' OR
             apply_url ILIKE '%jobs.ashbyhq.com%' OR
             apply_url ILIKE '%myworkdayjobs.com%' OR
             apply_url ILIKE '%jobs.jobvite.com%' THEN 'ats_direct'
        WHEN apply_url ILIKE '%linkedin.com%' THEN 'linkedin'
        WHEN apply_url ILIKE '%indeed.com%'   THEN 'indeed'
        WHEN apply_url ILIKE '%glassdoor.com%' THEN 'glassdoor'
        WHEN apply_url ILIKE '%ziprecruiter.com%' THEN 'ziprecruiter'
        ELSE 'original'
      END)
      WHERE link_confidence IS NULL
    `);

    // ── Step 2: Find broken links worth rescuing via Gemini ──────────────────
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      console.log('[LinkValidator] GEMINI_API_KEY not set — skipping Gemini resolution');
      return;
    }

    let query: string;
    let params: unknown[];
    if (jobIds && jobIds.length > 0) {
      query = `
        SELECT id, title, company, location, apply_url, match_score
        FROM jobs
        WHERE id = ANY($1)
          AND url_ok = false
          AND was_resolved_by_gemini = false
          AND (match_score IS NULL OR match_score >= 50)
        ORDER BY match_score DESC NULLS LAST
        LIMIT 30
      `;
      params = [jobIds];
    } else {
      query = `
        SELECT id, title, company, location, apply_url, match_score
        FROM jobs
        WHERE url_ok = false
          AND was_resolved_by_gemini = false
          AND (match_score IS NULL OR match_score >= 50)
        ORDER BY match_score DESC NULLS LAST
        LIMIT 30
      `;
      params = [];
    }

    const { rows: toResolve } = await pool.query(query, params);
    if (!toResolve.length) {
      console.log('[LinkValidator] No broken links to resolve via Gemini');
      return;
    }

    console.log(`[LinkValidator] Gemini resolving ${toResolve.length} broken links (score ≥ 50)…`);
    let resolved = 0, failed = 0;

    // Process sequentially to be polite to the Gemini API (not concurrent)
    for (const job of toResolve) {
      try {
        const result = await resolveJobUrlWithGemini(job.title, job.company, job.location ?? '');
        if (result) {
          const conf = computeLinkConfidence(result.url, true, true);
          await pool.query(
            `UPDATE jobs
             SET canonical_url            = $1,
                 canonical_source         = $2,
                 link_confidence          = $3,
                 was_resolved_by_gemini   = true,
                 url_ok                   = true,
                 url_checked_at           = NOW(),
                 validation_notes         = $4
             WHERE id = $5`,
            [
              result.url,
              result.source,
              conf,
              `Gemini resolved to ${result.source}: ${result.url}`,
              job.id,
            ],
          );
          console.log(`[LinkValidator]  ✓ ${job.title} @ ${job.company} → ${result.url}`);
          resolved++;
        } else {
          await pool.query(
            `UPDATE jobs SET was_resolved_by_gemini = true, validation_notes = 'Gemini could not find live posting' WHERE id = $1`,
            [job.id],
          );
          failed++;
        }
        // Rate-limit pause between Gemini calls
        await new Promise(r => setTimeout(r, 1500));
      } catch (e) {
        console.warn(`[LinkValidator]  ✗ Failed to resolve ${job.title} @ ${job.company}: ${e instanceof Error ? e.message : e}`);
        failed++;
      }
    }

    console.log(`[LinkValidator] Gemini resolution complete: ${resolved} resolved, ${failed} unresolvable`);
  } catch (e) {
    console.error('[LinkValidator] Fatal error in canonical resolution:', e);
  }
}
