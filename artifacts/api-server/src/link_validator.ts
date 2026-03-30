/**
 * Job Recovery & Canonical Resolution Engine
 *
 * Philosophy: RECOVERY FIRST, suppression last.
 *
 * When a job has a weak, aggregator, broken, or low-quality link:
 *   1. Find the real canonical posting (Gemini grounded search)
 *   2. Fetch the actual current job description from that source
 *   3. Replace scraped metadata with the recovered authoritative version
 *   4. Mark the job as 'recovered' so the UI shows the best available data
 *
 * Suppression only happens when ALL recovery attempts fail for a job.
 *
 * ── Recovery trigger conditions ───────────────────────────────────────────────
 *   A. url_ok = false (broken link)                    → must find a working URL
 *   B. Aggregator link (LinkedIn/Indeed) + score ≥ 55  → upgrade to direct ATS
 *   C. Description missing or < 120 chars + score ≥ 50 → fetch real description
 *   D. validation_status = 'suspicious'                → re-attempt
 *
 * ── ATS API support ───────────────────────────────────────────────────────────
 *   Greenhouse → boards.greenhouse.io/{co}/jobs/{id}.json (public, no auth)
 *   Lever      → api.lever.co/v0/postings/{co}/{id} (public, no auth)
 *   Ashby      → HTML fetch + structured data parse
 *   Other      → HTML fetch + best-effort title/description extraction
 *
 * ── Resolved fields ───────────────────────────────────────────────────────────
 *   canonical_url, canonical_source, original_url, original_title,
 *   original_description, resolved_title, resolved_description, resolved_location,
 *   resolved_metadata_json, metadata_last_verified_at, validation_status, page_type,
 *   link_confidence, was_resolved_by_gemini, validation_notes
 */

import { GoogleGenAI } from '@google/genai';
import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SourceTrust     = 'ats_direct' | 'company_career' | 'aggregator' | 'unknown';
export type LinkConfidence  = 'high' | 'medium' | 'low' | 'unknown';
export type ValidationStatus = 'validated' | 'recovered' | 'suspicious' | 'failed' | 'pending';
export type PageType        = 'job_detail' | 'careers_home' | 'aggregator' | 'unknown';

export interface FetchedJobData {
  title?:          string;
  company?:        string;
  location?:       string;
  description?:    string;
  employmentType?: string;
  postedAt?:       string;
  pageType:        PageType;
  sourceApi:       string;   // 'greenhouse' | 'lever' | 'ashby' | 'html'
}

// ── Domain classification ─────────────────────────────────────────────────────

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
  'grnh.se',
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
  'builtin.com',
  'builtinnyc.com',
  'builtinsf.com',
  'builtinchicago.com',
];

const CAREER_PATH_PATTERNS = ['/careers/', '/careers#', '/jobs/', '/openings/', '/positions/', '/apply/', '/job/'];

export function classifySourceTrust(url: string): SourceTrust {
  if (!url) return 'unknown';
  const lower = url.toLowerCase();
  if (ATS_DOMAINS.some(d => lower.includes(d))) return 'ats_direct';
  if (AGGREGATOR_DOMAINS.some(d => lower.includes(d))) return 'aggregator';
  if (CAREER_PATH_PATTERNS.some(p => lower.includes(p))) return 'company_career';
  return 'unknown';
}

export function computeLinkConfidence(
  url: string,
  urlOk: boolean | null,
  wasResolvedByGemini = false,
): LinkConfidence {
  const trust = classifySourceTrust(url);
  if (wasResolvedByGemini && urlOk !== false) return 'high';
  if (urlOk === true) {
    if (trust === 'ats_direct' || trust === 'company_career') return 'high';
    return 'medium';
  }
  if (urlOk === false) return 'low';
  if (trust === 'ats_direct' || trust === 'company_career') return 'medium';
  if (trust === 'aggregator') return 'low';
  return 'unknown';
}

// ── Recovery trigger logic ────────────────────────────────────────────────────

/**
 * Returns true if a job should enter the recovery pipeline.
 * Never blocks a job just because it has a live aggregator link —
 * aggregators are always worth upgrading to a direct ATS source.
 */
export function needsRecovery(job: {
  url_ok?: boolean | null;
  apply_url?: string;
  description?: string | null;
  match_score?: number | null;
  validation_status?: string | null;
  was_resolved_by_gemini?: boolean | null;
}): boolean {
  const status = job.validation_status ?? 'pending';
  if (status === 'validated' || status === 'recovered') return false;

  if (job.url_ok === false) return true;

  const trust = classifySourceTrust(job.apply_url ?? '');
  const score = job.match_score ?? 0;

  // Always try to upgrade aggregator links to direct ATS for high-enough-scoring jobs
  if (trust === 'aggregator' && score >= 55) return true;

  // Fetch description if it's missing or very short
  const descLen = (job.description ?? '').replace(/<[^>]+>/g, '').trim().length;
  if (descLen < 120 && score >= 50) return true;

  return false;
}

// ── ATS-specific description fetchers ────────────────────────────────────────

/**
 * Greenhouse public JSON API — no auth required.
 * Returns clean structured job data from boards.greenhouse.io/{co}/jobs/{id}.json
 */
async function fetchFromGreenhouseApi(url: string): Promise<FetchedJobData | null> {
  const match = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  if (!match) return null;
  const [, company, jobId] = match;

  // Determine if this is a job-boards.greenhouse.io URL (newer subdomain)
  const isJobBoards = url.includes('job-boards.greenhouse.io');

  // Try both API endpoints: preserve original subdomain first, then the other
  const apiUrls = isJobBoards
    ? [
        `https://job-boards.greenhouse.io/${company}/jobs/${jobId}.json`,
        `https://boards.greenhouse.io/${company}/jobs/${jobId}.json`,
      ]
    : [
        `https://boards.greenhouse.io/${company}/jobs/${jobId}.json`,
        `https://job-boards.greenhouse.io/${company}/jobs/${jobId}.json`,
      ];

  for (const apiUrl of apiUrls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobScout/1.0)', Accept: 'application/json' },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;

      const data = await res.json() as Record<string, unknown>;
      // Make sure we got actual job data (has a title field), not an error page
      if (!data.title && !data.content) continue;

      const rawHtml = (data.content as string) ?? '';
      const desc = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
      const location = (data.location as { name?: string } | undefined)?.name;
      const title = (data.title as string) || undefined;

      // Sanity check: if the fetched title is unrelated to what we expect, skip
      if (!title && !desc) continue;

      return { title, location, description: desc || undefined, postedAt: (data.updated_at as string) || undefined, pageType: 'job_detail', sourceApi: 'greenhouse' };
    } catch { /* try next */ }
  }
  return null;
}

/**
 * Lever public API — no auth required.
 * Returns clean structured data from api.lever.co/v0/postings/{co}/{id}
 */
async function fetchFromLeverApi(url: string): Promise<FetchedJobData | null> {
  const match = url.match(/lever\.co\/([^/?#]+)\/([a-f0-9-]{8,})/i);
  if (!match) return null;
  const [, company, jobId] = match;
  const apiUrl = `https://api.lever.co/v0/postings/${company}/${jobId}`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(apiUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobScout/1.0)', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const cats = data.categories as Record<string, unknown> | undefined;
    const lists = (data.lists as Array<{ text?: string; content?: string }>) ?? [];
    const sections = [
      (data.description as string) ?? '',
      ...lists.map(l => `${l.text ?? ''}:\n${l.content ?? ''}`),
      (data.closing as string) ?? '',
    ];
    const desc = sections.join('\n\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000);
    const location = (cats?.location as string)
      ?? ((cats?.allLocations as string[] | undefined)?.[0]);
    return {
      title:       (data.text as string) || undefined,
      location,
      description: desc || undefined,
      postedAt:    data.createdAt ? new Date(data.createdAt as number).toISOString() : undefined,
      pageType:    'job_detail',
      sourceApi:   'lever',
    };
  } catch {
    return null;
  }
}

/**
 * Generic HTML fetcher for Ashby, company career pages, and unknown ATSes.
 * Extracts best-effort title and description from page HTML.
 */
async function fetchFromHtml(url: string): Promise<FetchedJobData | null> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Accept: 'text/html',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const html = await res.text();

    // Extract title from <title> tag or <h1>
    const titleMatch =
      html.match(/<h1[^>]*>([^<]{10,120})<\/h1>/i) ??
      html.match(/<title>([^<|–-]{10,120})/i);
    const rawTitle = titleMatch?.[1]?.trim().replace(/\s+/g, ' ');

    // Extract description: look for JSON-LD first (most reliable)
    let desc = '';
    const jsonLdMatch = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonLdMatch) {
      try {
        const jsonLd = JSON.parse(jsonLdMatch[1]) as Record<string, unknown>;
        const rawDesc = (jsonLd.description as string) ?? '';
        desc = rawDesc.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      } catch { /* continue */ }
    }

    // Fall back to main content area if no JSON-LD
    if (desc.length < 100) {
      const bodyMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
        ?? html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)
        ?? html.match(/<div[^>]+(?:job|posting|description)[^>]*>([\s\S]{200,}?)<\/div>/i);
      if (bodyMatch) {
        desc = bodyMatch[1]
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 6000);
      }
    }

    // Classify page type
    const lower = url.toLowerCase();
    let pageType: PageType = 'unknown';
    if (ATS_DOMAINS.some(d => lower.includes(d))) {
      // ATS domain — check if it's a job detail (has numeric/UUID ID in path)
      pageType = /\/jobs?\/[\w-]{6,}/.test(lower) ? 'job_detail' : 'careers_home';
    } else if (AGGREGATOR_DOMAINS.some(d => lower.includes(d))) {
      pageType = 'aggregator';
    } else if (CAREER_PATH_PATTERNS.some(p => lower.includes(p))) {
      pageType = /[\w-]{6,}$/.test(lower) ? 'job_detail' : 'careers_home';
    }

    return {
      title:       rawTitle && rawTitle.length < 150 ? rawTitle : undefined,
      description: desc.length >= 50 ? desc : undefined,
      pageType,
      sourceApi:   'html',
    };
  } catch {
    return null;
  }
}

/**
 * Main dispatcher: fetches real job data from a canonical URL.
 * Tries API-first for known ATS platforms, falls back to HTML parsing.
 */
export async function fetchJobDescriptionFromCanonicalUrl(url: string): Promise<FetchedJobData | null> {
  const lower = url.toLowerCase();
  try {
    if (lower.includes('greenhouse.io')) {
      const result = await fetchFromGreenhouseApi(url);
      if (result?.description) return result;
    }
    if (lower.includes('lever.co')) {
      const result = await fetchFromLeverApi(url);
      if (result?.description) return result;
    }
    // For Ashby and all other ATSes/company pages: HTML fetch
    return await fetchFromHtml(url);
  } catch {
    return null;
  }
}

// ── Gemini URL resolver ───────────────────────────────────────────────────────

/**
 * Uses Gemini grounded search to find the canonical live posting URL for a job.
 * Expanded from v1 to also handle aggregator-to-ATS upgrades, not just broken links.
 */
export async function resolveJobUrlWithGemini(
  title: string,
  company: string,
  location: string,
  currentUrl?: string,
): Promise<{ url: string; source: string } | null> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) return null;

  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL?.trim() || 'gemini-3-flash-preview';

  const currentTrust = currentUrl ? classifySourceTrust(currentUrl) : 'unknown';
  const isUpgrade = currentTrust === 'aggregator'; // upgrade, not just repair

  const queries = isUpgrade
    ? [
        `site:boards.greenhouse.io "${company}" "${title}"`,
        `site:jobs.lever.co "${company}" "${title}"`,
        `site:jobs.ashbyhq.com "${company}" "${title}"`,
        `"${company}" "${title}" careers apply direct`,
      ]
    : [
        `"${company}" "${title}" site:boards.greenhouse.io OR site:jobs.lever.co OR site:jobs.ashbyhq.com`,
        `"${company}" "${title}" job opening current hiring careers page`,
        `${company} "${title}" ${location} apply now`,
      ];

  const prompt = `Find the current, live direct job posting URL for this role:
Job Title: "${title}"
Company: "${company}"
Location: "${location || 'US'}"
${isUpgrade ? `Current link is an aggregator — find the company's direct ATS or careers page posting instead.` : ''}

Prioritize in this order:
1. boards.greenhouse.io / jobs.lever.co / jobs.ashbyhq.com / myworkdayjobs.com
2. The company's own careers page (direct job posting, not careers home)
3. Any reliable direct source

Return ONLY the single best URL you find, nothing else. If not found, return: NOT_FOUND`;

  for (const q of queries) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: `${prompt}\n\nSearch: ${q}` }] }],
        config: { tools: [{ googleSearch: {} }], temperature: 0 },
      });

      const text = (response.text ?? '').trim();
      if (!text || text.includes('NOT_FOUND')) continue;

      const urlMatch = text.match(/https?:\/\/[^\s\n"'<>()\],;]+/);
      if (!urlMatch) continue;
      const candidateUrl = urlMatch[0].replace(/[.,;!?)]+$/, '');

      // Must be an improvement over the current URL (not just another aggregator)
      const candidateTrust = classifySourceTrust(candidateUrl);
      if (candidateTrust === 'aggregator') continue;

      // Liveness check
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 7000);
        const headRes = await fetch(candidateUrl, {
          method: 'HEAD',
          redirect: 'follow',
          signal: ctrl.signal,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobScout/1.0)' },
        });
        clearTimeout(timer);
        if (headRes.status < 400) {
          const sourceLabel = candidateTrust === 'ats_direct'    ? 'gemini_resolved_ats'
            : candidateTrust === 'company_career'                ? 'gemini_resolved_company'
            :                                                       'gemini_resolved';
          return { url: candidateUrl, source: sourceLabel };
        }
      } catch { /* try next */ }
    } catch (e) {
      console.warn(`[Recovery] Gemini search failed: ${e instanceof Error ? e.message : e}`);
      break;
    }
  }
  return null;
}

// ── Confidence stamp (fast, SQL-based, no I/O) ────────────────────────────────

async function stampLinkConfidence(pool: Pool): Promise<void> {
  await pool.query(`
    UPDATE jobs
    SET link_confidence = CASE
      WHEN url_ok = true AND (
        apply_url ILIKE '%boards.greenhouse.io%' OR apply_url ILIKE '%job-boards.greenhouse.io%' OR
        apply_url ILIKE '%jobs.lever.co%' OR apply_url ILIKE '%hire.lever.co%' OR
        apply_url ILIKE '%jobs.ashbyhq.com%' OR apply_url ILIKE '%myworkdayjobs.com%' OR
        apply_url ILIKE '%jobs.jobvite.com%' OR apply_url ILIKE '%bamboohr.com%' OR
        apply_url ILIKE '%smartrecruiters.com%' OR apply_url ILIKE '%apply.workable.com%'
      ) THEN 'high'
      WHEN url_ok = true  THEN 'medium'
      WHEN url_ok = false THEN 'low'
      WHEN apply_url ILIKE '%boards.greenhouse.io%' OR apply_url ILIKE '%jobs.lever.co%' OR
           apply_url ILIKE '%jobs.ashbyhq.com%' OR apply_url ILIKE '%myworkdayjobs.com%'
        THEN 'medium'
      WHEN apply_url ILIKE '%linkedin.com%' OR apply_url ILIKE '%indeed.com%' OR
           apply_url ILIKE '%glassdoor.com%' OR apply_url ILIKE '%ziprecruiter.com%'
        THEN 'low'
      ELSE 'unknown'
    END,
    canonical_url    = COALESCE(canonical_url, apply_url),
    original_url     = COALESCE(original_url, apply_url),
    original_title   = COALESCE(original_title, title),
    original_description = COALESCE(original_description, description),
    canonical_source = COALESCE(canonical_source, CASE
      WHEN apply_url ILIKE '%boards.greenhouse.io%' OR apply_url ILIKE '%job-boards.greenhouse.io%' OR
           apply_url ILIKE '%jobs.lever.co%' OR apply_url ILIKE '%jobs.ashbyhq.com%' OR
           apply_url ILIKE '%myworkdayjobs.com%' OR apply_url ILIKE '%jobs.jobvite.com%' THEN 'ats_direct'
      WHEN apply_url ILIKE '%linkedin.com%'     THEN 'linkedin'
      WHEN apply_url ILIKE '%indeed.com%'        THEN 'indeed'
      WHEN apply_url ILIKE '%glassdoor.com%'    THEN 'glassdoor'
      WHEN apply_url ILIKE '%ziprecruiter.com%' THEN 'ziprecruiter'
      ELSE 'original'
    END),
    validation_status = COALESCE(validation_status, 'pending')
    WHERE link_confidence IS NULL
  `);
}

// ── Shared DB write helper ─────────────────────────────────────────────────────

/** Returns true if a fetched title looks like a careers home/listing page, not a job title. */
function isListingPageTitle(t: string | undefined): boolean {
  if (!t) return false;
  const low = t.toLowerCase().trim();
  return (
    low.startsWith('current opening') ||
    low.startsWith('open role') ||
    low.startsWith('job opportunit') ||
    low.startsWith('career') ||
    low.endsWith('careers') ||
    low.endsWith('jobs') ||
    low.endsWith('job opportunities') ||
    low.endsWith('job openings') ||
    /^(all |open )?(jobs|roles|positions|opportunities)$/.test(low) ||
    /careers? (page|portal|site|hub)/.test(low) ||
    /^(work at|join us at|jobs at|careers at|opportunities at)/.test(low) ||
    /\bcurrent opening(s)?\b/.test(low)
  );
}

/** Returns true if a description string looks like a careers listing page, not a job description. */
function isListingPageDescription(d: string | undefined): boolean {
  if (!d) return false;
  const low = d.toLowerCase().slice(0, 120).trim();
  return (
    low.startsWith('current opening') ||
    low.startsWith('open roles') ||
    low.startsWith('open opportunities') ||
    low.includes('create a job alert') ||
    low.startsWith('job opportunities') ||
    /^(all |current )?(jobs|openings|opportunities|positions) at /.test(low)
  );
}

async function writeRecoveryResult(
  pool: Pool,
  jobId: number,
  canonicalUrl: string,
  canonicalSource: string,
  usedGemini: boolean,
  fetchedData: FetchedJobData | null,
  originalApplyUrl: string,
): Promise<ValidationStatus> {
  // Discard fetched titles that are clearly careers-listing pages, not job titles
  if (fetchedData?.title && isListingPageTitle(fetchedData.title)) {
    fetchedData = { ...fetchedData, title: undefined };
  }
  // Discard fetched descriptions that are clearly careers-listing pages, not job descriptions
  if (fetchedData?.description && isListingPageDescription(fetchedData.description)) {
    fetchedData = { ...fetchedData, description: undefined };
  }

  const hasCanonicalData = !!(fetchedData?.description && fetchedData.description.length >= 50);
  const isUpgraded = canonicalUrl !== originalApplyUrl || usedGemini;

  let validationStatus: ValidationStatus;
  let validationNotes = '';

  if (hasCanonicalData && (usedGemini || classifySourceTrust(canonicalUrl) === 'ats_direct')) {
    validationStatus = 'recovered';
    validationNotes = `Recovered via ${usedGemini ? 'Gemini+fetch' : 'direct API'} from ${canonicalSource} (${fetchedData!.description!.length} chars)`;
  } else if (hasCanonicalData) {
    validationStatus = 'validated';
    validationNotes = `Validated from ${canonicalSource}: description fetched (${fetchedData!.description!.length} chars)`;
  } else if (isUpgraded) {
    validationStatus = 'recovered';
    validationNotes = `URL upgraded to ${canonicalSource}; description fetch returned no content`;
  } else {
    validationStatus = 'failed';
    validationNotes = 'No better canonical source found and description fetch failed';
  }

  const confidence = computeLinkConfidence(canonicalUrl, usedGemini ? true : null, usedGemini);

  await pool.query(
    `UPDATE jobs
     SET canonical_url              = $1,
         canonical_source           = $2,
         link_confidence            = $3,
         was_resolved_by_gemini     = $4,
         validation_status          = $5,
         validation_notes           = $6,
         resolved_title             = COALESCE($7, resolved_title),
         resolved_description       = COALESCE($8, resolved_description),
         resolved_location          = COALESCE($9, resolved_location),
         resolved_metadata_json     = COALESCE($10, resolved_metadata_json),
         metadata_last_verified_at  = NOW(),
         url_ok                     = CASE WHEN $4 = true THEN true ELSE url_ok END,
         url_checked_at             = CASE WHEN $4 = true THEN NOW() ELSE url_checked_at END,
         page_type                  = COALESCE($11, page_type)
     WHERE id = $12`,
    [
      canonicalUrl,
      canonicalSource,
      confidence,
      usedGemini,
      validationStatus,
      validationNotes,
      fetchedData?.title?.trim() || null,
      fetchedData?.description?.trim() || null,
      fetchedData?.location?.trim() || null,
      fetchedData ? JSON.stringify({
        sourceApi: fetchedData.sourceApi,
        pageType:  fetchedData.pageType,
        postedAt:  fetchedData.postedAt,
        fetchedAt: new Date().toISOString(),
      }) : null,
      fetchedData?.pageType || null,
      jobId,
    ],
  );

  return validationStatus;
}

// ── Main recovery engine ──────────────────────────────────────────────────────

/**
 * Background recovery engine. Runs after the URL health check.
 *
 * Phase A (fast, parallel): Direct ATS jobs (Greenhouse/Lever/Ashby) with short/missing
 *   descriptions → fetch from public JSON APIs concurrently. No Gemini, no rate limits.
 *
 * Phase B (slow, sequential): Aggregator-sourced and broken-link jobs → use Gemini web
 *   search to find the canonical ATS URL, then fetch the description. Capped at 15 jobs
 *   per run with 1.5 s between Gemini calls.
 *
 * Never blocks the pipeline. Call with .catch(() => {}).
 */
export async function runCanonicalResolutionInBackground(
  pool: Pool,
  jobIds?: number[],
): Promise<void> {
  try {
    // ── Step 1: Stamp initial confidence for all unstamped jobs ──────────────
    await stampLinkConfidence(pool);

    console.log(`\n──── JOB RECOVERY ENGINE ────────────────────────────────────`);

    const scopeClause = jobIds?.length ? 'AND j.id = ANY($1)' : '';
    const params: unknown[] = jobIds?.length ? [jobIds] : [];

    // ── PHASE A: Direct ATS description fetch (fast, parallel) ───────────────
    // Jobs that already have a good ATS URL but are missing/short descriptions.
    const { rows: atsJobs } = await pool.query(`
      SELECT j.id, j.title, j.company, j.location, j.apply_url, j.description,
             j.match_score, j.url_ok, j.canonical_url, j.canonical_source,
             j.validation_status
      FROM jobs j
      WHERE j.validation_status NOT IN ('validated', 'recovered')
        AND j.canonical_source = 'ats_direct'
        AND j.url_ok IS NOT FALSE
        AND (j.description IS NULL OR LENGTH(j.description) < 120)
        ${scopeClause}
      ORDER BY j.match_score DESC NULLS LAST
      LIMIT 50
    `, params);

    if (atsJobs.length) {
      console.log(`[Recovery Phase A] ${atsJobs.length} ATS jobs needing description fetch (parallel)`);
      let aOk = 0, aFail = 0;
      // Process in batches of 10 concurrently
      for (let i = 0; i < atsJobs.length; i += 10) {
        const batch = atsJobs.slice(i, i + 10);
        await Promise.all(batch.map(async (job) => {
          try {
            const url: string = job.canonical_url ?? job.apply_url ?? '';
            if (!url) { aFail++; return; }
            const fetchedData = await fetchJobDescriptionFromCanonicalUrl(url);
            const status = await writeRecoveryResult(
              pool, job.id, url, job.canonical_source ?? 'ats_direct',
              false, fetchedData, job.apply_url ?? '',
            );
            if (status === 'validated' || status === 'recovered') {
              aOk++;
              const descLen = fetchedData?.description?.length ?? 0;
              console.log(`[Recovery Phase A] ✓ ${job.company} "${(job.title as string).slice(0, 40)}" → ${status} (${descLen} chars)`);
            } else {
              aFail++;
            }
          } catch (e) {
            aFail++;
            await pool.query(
              `UPDATE jobs SET validation_status='failed', validation_notes=$1 WHERE id=$2`,
              [`Phase A error: ${e instanceof Error ? e.message : String(e)}`, job.id],
            );
          }
        }));
      }
      console.log(`[Recovery Phase A] Done: ${aOk} validated, ${aFail} failed`);
    }

    // ── PHASE B: Gemini URL resolver for aggregator + broken links (sequential) ─
    const hasGemini = !!process.env.GEMINI_API_KEY?.trim();
    const { rows: geminiJobs } = await pool.query(`
      SELECT j.id, j.title, j.company, j.location, j.apply_url, j.description,
             j.match_score, j.url_ok, j.canonical_url, j.canonical_source,
             j.validation_status, j.was_resolved_by_gemini
      FROM jobs j
      WHERE j.validation_status NOT IN ('validated', 'recovered')
        AND j.was_resolved_by_gemini IS NOT TRUE
        AND (
          j.url_ok = false
          OR j.canonical_source IN ('linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'aggregator')
        )
        AND (j.match_score >= 55 OR j.match_score IS NULL)
        ${scopeClause}
      ORDER BY j.match_score DESC NULLS LAST
      LIMIT 15
    `, params);

    if (!geminiJobs.length) {
      console.log(`[Recovery Phase B] No aggregator/broken-link jobs to resolve`);
      console.log(`──────────────────────────────────────────────────────────────\n`);
      return;
    }

    console.log(`[Recovery Phase B] ${geminiJobs.length} aggregator/broken jobs | Gemini: ${hasGemini ? 'enabled' : 'disabled'}`);
    let bUpgraded = 0, bDescFetched = 0, bFailed = 0;

    for (const job of geminiJobs) {
      try {
        let canonicalUrl: string = job.canonical_url ?? job.apply_url ?? '';
        let canonicalSource: string = job.canonical_source ?? 'original';
        let usedGemini = false;

        if (hasGemini) {
          const resolved = await resolveJobUrlWithGemini(
            job.title, job.company, job.location ?? '', canonicalUrl,
          );
          if (resolved) {
            canonicalUrl = resolved.url;
            canonicalSource = resolved.source;
            usedGemini = true;
            bUpgraded++;
            console.log(`[Recovery Phase B] ↗ ${job.company} "${(job.title as string).slice(0, 40)}" → ${resolved.source}`);
          }
          // Rate-limit Gemini calls
          await new Promise(r => setTimeout(r, 1500));
        }

        // Even if Gemini didn't improve the URL, try fetching the current URL
        const fetchedData = canonicalUrl ? await fetchJobDescriptionFromCanonicalUrl(canonicalUrl) : null;

        const status = await writeRecoveryResult(
          pool, job.id, canonicalUrl, canonicalSource, usedGemini, fetchedData, job.apply_url ?? '',
        );

        if (status === 'recovered' || status === 'validated') {
          if (fetchedData?.description) bDescFetched++;
          console.log(`[Recovery Phase B] ✓ ${job.company} "${(job.title as string).slice(0, 40)}" → ${status}`);
        } else {
          bFailed++;
        }

      } catch (e) {
        console.warn(`[Recovery Phase B] ✗ ${job.title} @ ${job.company}: ${e instanceof Error ? e.message : e}`);
        bFailed++;
        await pool.query(
          `UPDATE jobs SET validation_status='failed', validation_notes=$1, was_resolved_by_gemini=true WHERE id=$2`,
          [`Phase B error: ${e instanceof Error ? e.message : String(e)}`, job.id],
        );
      }
    }

    console.log(`[Recovery Phase B] Done: ${bUpgraded} URL-upgraded, ${bDescFetched} descriptions fetched, ${bFailed} failed`);
    console.log(`──────────────────────────────────────────────────────────────\n`);

  } catch (e) {
    console.error('[Recovery] Fatal error:', e);
  }
}
