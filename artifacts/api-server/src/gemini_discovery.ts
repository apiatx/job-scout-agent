/**
 * Gemini Discovery Service
 *
 * Uses the current @google/genai SDK (v1.x, recommended unified SDK) with
 * Google Search grounding to supplement JobSpy with job listings and direct
 * company career pages that board-scraping may miss.
 *
 * Architecture rules (strictly enforced):
 *   Gemini  = discovery + enrichment ONLY
 *   Backend = deterministic gatekeeper (same hard filters apply to all sources)
 *   Claude  = resume tailoring / writing ONLY (downstream, after filtering)
 *
 * ── Model selection / fallback waterfall ─────────────────────────────────────
 *
 * Google Search grounding tool names by model family (per Google docs):
 *
 *   Gemini 2.0+ (incl. 2.5 and 3-series)  →  `googleSearch: {}`
 *   Gemini 1.5                             →  `googleSearchRetrieval: {}`
 *
 * Gemini 3 IS a current Google model family. gemini-3-flash-preview and
 * gemini-3.1-pro-preview are documented, supported model identifiers.
 * gemini-2.0-flash is deprecated by Google and excluded from the default chain.
 *
 * Candidate waterfall (tried in order until one succeeds):
 *   1. GEMINI_MODEL env var       — user-configured override (any valid name)
 *   2. gemini-3-flash-preview     — speed/cost default; Gemini 3, googleSearch ✅
 *   3. gemini-3.1-pro-preview     — quality upgrade; Gemini 3, googleSearch ✅
 *   4. gemini-flash-latest        — alias fallback; googleSearch ✅
 *   5. gemini-pro-latest          — alias fallback; googleSearch ✅
 *
 * If GEMINI_MODEL matches an entry in the built-in list, the duplicate is
 * removed so the model is only tried once (at the front of the chain).
 *
 * The waterfall catches model-unavailability errors and advances to the next
 * candidate. Which model was actually used is logged prominently.
 *
 * Environment variables:
 *   GEMINI_API_KEY           — required; module skipped gracefully if absent
 *   GEMINI_MODEL             — override; prepended to front of candidate chain
 *   GEMINI_ENABLE_SEARCH     — default: true   (set to "false" to disable)
 *   GEMINI_MAX_RESULTS       — default: 30     (cap on jobs per run)
 *   GEMINI_TIMEOUT_SECONDS   — default: 90
 *
 * Future hook: GEMINI_DEEP_RESEARCH=true is reserved for a future optional
 * premium "deep company/role research" mode. Not implemented yet.
 */

import {
  GoogleGenAI,
  type GroundingMetadata,
  type GroundingChunk,
  DynamicRetrievalConfigMode,
} from '@google/genai';
import type { ScrapedJob } from './scraper.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GeminiJob extends ScrapedJob {
  source: string;
  geminiGroundingMetadata?: GroundingMetadata;
  geminiSources?: GeminiSource[];
  geminiWebSearchQueries?: string[];
  ingestionConfidence: number; // 0–1
}

export interface GeminiSource {
  uri: string;
  title?: string;
}

export interface GeminiDiscoveryCriteria {
  target_roles: string[];
  locations: string[];
  work_type: string;       // 'remote' | 'hybrid' | 'onsite' | 'any'
  must_have: string[];
  nice_to_have: string[];
  avoid: string[];
  industries: string[];
  min_salary?: number | null;
}

export interface GeminiDiscoveryResult {
  jobs: GeminiJob[];
  queriesUsed: string[];
  totalGroundingSources: number;
  modelUsed: string | null;    // which model actually succeeded
  skipped: boolean;
  skipReason?: string;
}

interface RawGeminiJobRecord {
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  apply_url?: string;
  description?: string;
  salary?: string;
}

// ── Model candidate definitions ───────────────────────────────────────────────

type GroundingToolFamily = 'googleSearch' | 'googleSearchRetrieval';

interface ModelCandidate {
  modelName: string;
  toolFamily: GroundingToolFamily;
  note: string;
}

/**
 * Built-in candidate chain — Gemini 3-series models first (current generation),
 * with alias fallbacks. gemini-2.0-flash intentionally excluded (deprecated by Google).
 */
const BUILTIN_CANDIDATES: ModelCandidate[] = [
  {
    modelName: 'gemini-3-flash-preview',
    toolFamily: 'googleSearch',
    note: 'Gemini 3 Flash — speed/cost default; googleSearch grounding ✅',
  },
  {
    modelName: 'gemini-3.1-pro-preview',
    toolFamily: 'googleSearch',
    note: 'Gemini 3.1 Pro — quality upgrade; googleSearch grounding ✅',
  },
  {
    modelName: 'gemini-flash-latest',
    toolFamily: 'googleSearch',
    note: 'alias fallback — resolves to latest supported Flash model',
  },
  {
    modelName: 'gemini-pro-latest',
    toolFamily: 'googleSearch',
    note: 'alias fallback — resolves to latest supported Pro model',
  },
];

/** Detects which tool family a model name belongs to.
 *  Only Gemini 1.5-series uses the legacy googleSearchRetrieval tool.
 *  All 2.0+, 2.5, and 3-series models use the modern googleSearch tool.
 */
function detectToolFamily(modelName: string): GroundingToolFamily {
  if (modelName.startsWith('gemini-1.') || modelName.includes('-1.5') || modelName.includes('1.5-')) {
    return 'googleSearchRetrieval';
  }
  return 'googleSearch'; // Gemini 2.0, 2.5, 3.x and all current models
}

/** Builds the grounding tool config appropriate for the model family */
function buildGroundingTool(family: GroundingToolFamily): object {
  if (family === 'googleSearchRetrieval') {
    return {
      googleSearchRetrieval: {
        dynamicRetrievalConfig: { mode: DynamicRetrievalConfigMode.MODE_DYNAMIC },
      },
    };
  }
  return { googleSearch: {} };
}

/** True if an API error indicates the model is unavailable (vs a real content error) */
function isModelUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('model not found') ||
    msg.includes('404') ||
    msg.includes('not found') ||
    msg.includes('not available') ||
    msg.includes('unsupported model') ||
    msg.includes('invalid model') ||
    msg.includes('deprecated')
  );
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runGeminiJobDiscovery(
  criteria: GeminiDiscoveryCriteria
): Promise<GeminiDiscoveryResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.log('[Gemini] GEMINI_API_KEY not set — skipping Gemini discovery');
    return { jobs: [], queriesUsed: [], totalGroundingSources: 0, modelUsed: null, skipped: true, skipReason: 'GEMINI_API_KEY not configured' };
  }

  const enableSearch = (process.env.GEMINI_ENABLE_SEARCH ?? 'true').toLowerCase() !== 'false';
  if (!enableSearch) {
    console.log('[Gemini] GEMINI_ENABLE_SEARCH=false — skipping Gemini discovery');
    return { jobs: [], queriesUsed: [], totalGroundingSources: 0, modelUsed: null, skipped: true, skipReason: 'GEMINI_ENABLE_SEARCH=false' };
  }

  const maxResults = parseInt(process.env.GEMINI_MAX_RESULTS ?? '30', 10);
  const timeoutMs  = parseInt(process.env.GEMINI_TIMEOUT_SECONDS ?? '90', 10) * 1000;

  // Build the candidate list — user override goes first if set.
  // If the env model matches a built-in name, remove the duplicate from the
  // built-in list so each model is tried at most once.
  const envModel = process.env.GEMINI_MODEL?.trim();
  const builtinsWithoutEnvDupe = envModel
    ? BUILTIN_CANDIDATES.filter(c => c.modelName !== envModel)
    : BUILTIN_CANDIDATES;
  const candidates: ModelCandidate[] = envModel
    ? [{ modelName: envModel, toolFamily: detectToolFamily(envModel), note: 'user-configured via GEMINI_MODEL env var' }, ...builtinsWithoutEnvDupe]
    : [...builtinsWithoutEnvDupe];

  console.log(`\n──── GEMINI DISCOVERY ──────────────────────────────────────`);
  console.log(`[Gemini] Candidate chain: ${candidates.map(c => c.modelName).join(' → ')}`);
  console.log(`[Gemini] Max results: ${maxResults} | Timeout: ${timeoutMs / 1000}s`);
  console.log(`[Gemini] Roles: ${criteria.target_roles.slice(0, 3).join(', ')}${criteria.target_roles.length > 3 ? '...' : ''}`);
  console.log(`[Gemini] Locations: ${criteria.locations.join(', ') || 'Remote / US'}`);

  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildSearchPrompt(criteria, maxResults);

  // ── Waterfall: try each candidate until one succeeds ──────────────────────
  for (const candidate of candidates) {
    const { modelName, toolFamily, note } = candidate;
    const groundingTool = buildGroundingTool(toolFamily);

    console.log(`[Gemini] Trying: ${modelName} (${note}) [tool: ${toolFamily}]`);

    try {
      const requestPromise = ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          tools: [groundingTool],
          temperature: 0.1,
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs)
      );

      const response = await Promise.race([requestPromise, timeoutPromise]);
      const text = response.text ?? '';
      const groundingMeta: GroundingMetadata = response.candidates?.[0]?.groundingMetadata ?? {};

      const sources: GeminiSource[] = (groundingMeta.groundingChunks ?? [])
        .filter((c: GroundingChunk) => c.web?.uri)
        .map((c: GroundingChunk) => ({ uri: c.web!.uri!, title: c.web!.title }));

      const webSearchQueriesUsed: string[] = groundingMeta.webSearchQueries ?? [];

      console.log(`[Gemini] ✓ Model: ${modelName} — ${sources.length} grounding sources`);
      console.log(`[Gemini] Queries used: ${JSON.stringify(webSearchQueriesUsed)}`);

      const rawJobs = parseJobsFromText(text);
      console.log(`[Gemini] Parsed ${rawJobs.length} raw job records`);

      const jobs = normalizeGeminiJobs(rawJobs, groundingMeta, sources, webSearchQueriesUsed, criteria);
      const limited = jobs.slice(0, maxResults);

      console.log(`[Gemini] ${limited.length} valid normalized jobs (${rawJobs.length - limited.length} dropped/trimmed)`);
      console.log(`───────────────────────────────────────────────────────────`);

      return {
        jobs: limited,
        queriesUsed: webSearchQueriesUsed,
        totalGroundingSources: sources.length,
        modelUsed: modelName,
        skipped: false,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      if (isModelUnavailableError(err)) {
        console.warn(`[Gemini] ✗ ${modelName} unavailable: ${msg} — trying next candidate`);
        continue; // advance to next candidate
      }

      // Non-availability error (timeout, rate limit, content error, etc.)
      // Don't fall through to next model — fail fast and keep using JobSpy only
      console.error(`[Gemini] ✗ ${modelName} failed (non-availability error): ${msg}`);
      console.log(`[Gemini] Continuing with JobSpy/ATS results only`);
      console.log(`───────────────────────────────────────────────────────────`);
      return { jobs: [], queriesUsed: [], totalGroundingSources: 0, modelUsed: null, skipped: true, skipReason: `${modelName}: ${msg}` };
    }
  }

  // All candidates exhausted
  const tried = candidates.map(c => c.modelName).join(', ');
  console.error(`[Gemini] All candidates exhausted (tried: ${tried}) — skipping Gemini discovery`);
  console.log(`───────────────────────────────────────────────────────────`);
  return { jobs: [], queriesUsed: [], totalGroundingSources: 0, modelUsed: null, skipped: true, skipReason: `All model candidates unavailable: ${tried}` };
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildSearchPrompt(criteria: GeminiDiscoveryCriteria, maxResults: number): string {
  const roles      = criteria.target_roles.slice(0, 8).join(', ') || 'account executive, sales manager';
  const locations  = criteria.locations.join(', ') || 'Remote';
  const workType   = criteria.work_type === 'remote'  ? 'remote only'
                   : criteria.work_type === 'hybrid'  ? 'remote or hybrid'
                   : criteria.work_type === 'onsite'  ? 'on-site'
                   : 'any work arrangement';
  const mustHave   = criteria.must_have.slice(0, 6).join(', ');
  const industries = criteria.industries.slice(0, 4).join(', ');
  const salaryNote = criteria.min_salary ? `Minimum salary: $${criteria.min_salary.toLocaleString()}` : '';

  return `You are a job search assistant. Use Google Search to find currently open job listings matching these criteria:

TARGET ROLES: ${roles}
LOCATION / WORK TYPE: ${workType} — preferred locations: ${locations}
KEY SKILLS / KEYWORDS: ${mustHave || 'enterprise sales, SaaS, B2B'}
${industries ? `INDUSTRIES: ${industries}` : ''}
${salaryNote}

Search these sources (in priority order — prefer direct postings over aggregators):
1. site:greenhouse.io OR site:boards.greenhouse.io
2. site:lever.co OR site:jobs.lever.co
3. site:ashbyhq.com OR site:jobs.ashbyhq.com
4. site:myworkdayjobs.com
5. Direct company careers pages (e.g. company.com/careers or company.com/jobs)
6. LinkedIn job listings (only if direct ATS URL unavailable)

For each job found, I need:
- Exact job title
- Company name
- Location (write "Remote" if remote)
- Direct application URL (the actual job posting page, not a search results page)
- Brief description snippet (1–2 sentences from the posting)
- Salary range (if visible in the posting)

Output ONLY a JSON array between the markers JOBS_START and JOBS_END. No other text outside the markers:

JOBS_START
[
  {
    "title": "Enterprise Account Executive",
    "company": "Acme Corp",
    "location": "Remote",
    "url": "https://boards.greenhouse.io/acmecorp/jobs/12345",
    "description": "Lead enterprise sales cycles for Fortune 500 accounts...",
    "salary": "$150,000 - $180,000 base"
  }
]
JOBS_END

Rules:
- Find up to ${maxResults} unique, currently open positions
- Only include roles clearly matching the target roles list above
- Do NOT include expired, filled, or clearly irrelevant roles
- Prefer direct ATS URLs (greenhouse/lever/ashby/workday) over LinkedIn/Indeed links
- Do not fabricate jobs — only include roles you can verify exist via search`;
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseJobsFromText(text: string): RawGeminiJobRecord[] {
  // Strategy 1: explicit JOBS_START / JOBS_END markers
  const markerMatch = text.match(/JOBS_START\s*([\s\S]*?)\s*JOBS_END/);
  if (markerMatch) {
    const jsonStr = markerMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) return parsed as RawGeminiJobRecord[];
    } catch { /* fall through */ }
  }

  // Strategy 2: largest JSON array anywhere in the response
  const jsonMatches: string[] = (text.match(/\[[\s\S]*?\]/g) as string[] | null) ?? [];
  for (const candidate of jsonMatches.sort((a, b) => b.length - a.length)) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].title || parsed[0].url)) {
        return parsed as RawGeminiJobRecord[];
      }
    } catch { /* continue */ }
  }

  // Strategy 3: JSON object with a "jobs" key
  const objMatch = text.match(/\{[\s\S]*?"jobs"\s*:\s*\[[\s\S]*?\]\s*\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed.jobs)) return parsed.jobs as RawGeminiJobRecord[];
    } catch { /* fall through */ }
  }

  console.log('[Gemini] Could not parse structured job data. Response preview:', text.slice(0, 400));
  return [];
}

// ── URL utilities ─────────────────────────────────────────────────────────────

const KNOWN_ATS_DOMAINS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'jobs.ashbyhq.com',
  'boards.greenhouse.io', 'jobs.lever.co', 'myworkdayjobs.com',
  'icims.com', 'smartrecruiters.com', 'bamboohr.com', 'rippling.com',
  'workday.com', 'taleo.net', 'jobvite.com', 'recruitee.com',
];

const AGGREGATOR_DOMAINS = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com',
  'simplyhired.com', 'monster.com', 'dice.com',
];

export function isDirectCompanyUrl(url: string): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (KNOWN_ATS_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return true;
    if (AGGREGATOR_DOMAINS.some(d => host === d || host.endsWith('.' + d))) return false;
    return true;
  } catch {
    return false;
  }
}

export function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ref','referral']
      .forEach(p => u.searchParams.delete(p));
    return u.href.replace(/\/$/, '');
  } catch {
    return rawUrl.trim();
  }
}

// ── Confidence scorer ─────────────────────────────────────────────────────────

function scoreConfidence(job: RawGeminiJobRecord): number {
  let score = 0.45;
  const url = job.url ?? job.apply_url ?? '';
  if (url.startsWith('http'))                         score += 0.10;
  if (isDirectCompanyUrl(url))                        score += 0.15;
  if (job.description && job.description.length > 50) score += 0.10;
  if (job.title && job.title.length > 5)              score += 0.08;
  if (job.company && job.company.length > 1)          score += 0.07;
  if (job.salary)                                     score += 0.05;
  return Math.min(1, score);
}

// ── Normalizer ────────────────────────────────────────────────────────────────

function normalizeGeminiJobs(
  rawJobs: RawGeminiJobRecord[],
  groundingMeta: GroundingMetadata,
  sources: GeminiSource[],
  webSearchQueries: string[],
  criteria: GeminiDiscoveryCriteria,
): GeminiJob[] {
  const seen = new Set<string>();
  const results: GeminiJob[] = [];

  for (const raw of rawJobs) {
    const url     = (raw.url ?? raw.apply_url ?? '').trim();
    const title   = (raw.title   ?? '').trim();
    const company = (raw.company ?? '').trim();
    if (!url || !title || !company || !url.startsWith('http')) continue;

    const normalUrl = normalizeUrl(url);
    const dedupeKey = normalUrl || `${company.toLowerCase()}::${normalizeTitle(title)}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    results.push({
      title,
      company,
      location:    (raw.location ?? '').trim() || guessLocation(criteria),
      salary:      raw.salary ?? undefined,
      applyUrl:    normalUrl || url,
      description: raw.description ?? undefined,
      source:      'Gemini',
      geminiGroundingMetadata: groundingMeta,
      geminiSources:           sources,
      geminiWebSearchQueries:  webSearchQueries,
      ingestionConfidence:     scoreConfidence(raw),
    });
  }

  return results;
}

function guessLocation(criteria: GeminiDiscoveryCriteria): string {
  if (criteria.work_type === 'remote') return 'Remote';
  if (criteria.locations.length > 0)  return criteria.locations[0];
  return 'Unknown';
}

// ── Cross-source deduplication (used by pipeline in index.ts) ─────────────────

export function deduplicateJobLists(
  primary: Array<ScrapedJob & { source: string; _fromJobSpy?: boolean }>,
  gemini: GeminiJob[]
): {
  merged: Array<ScrapedJob & { source: string; _fromJobSpy?: boolean; _fromGemini?: boolean; ingestionConfidence?: number }>;
  deduplicatedCount: number;
} {
  const urlIndex = new Map<string, number>();
  const ckIndex  = new Map<string, number>();

  for (let i = 0; i < primary.length; i++) {
    const j   = primary[i];
    const url = normalizeUrl(j.applyUrl);
    if (url) urlIndex.set(url, i);
    ckIndex.set(`${j.company.toLowerCase().trim()}::${normalizeTitle(j.title)}`, i);
  }

  const merged: Array<ScrapedJob & { source: string; _fromJobSpy?: boolean; _fromGemini?: boolean; ingestionConfidence?: number }> = [...primary];
  let deduplicatedCount = 0;

  for (const gJob of gemini) {
    const normalUrl = normalizeUrl(gJob.applyUrl);
    const ck        = `${gJob.company.toLowerCase().trim()}::${normalizeTitle(gJob.title)}`;

    const existsByUrl   = normalUrl ? urlIndex.has(normalUrl) : false;
    const existsByTitle = ckIndex.has(ck);

    if (existsByUrl || existsByTitle) {
      const idx    = existsByUrl ? urlIndex.get(normalUrl)! : ckIndex.get(ck)!;
      let existing = merged[idx];
      // Upgrade aggregator URL to direct company URL
      if (gJob.applyUrl && isDirectCompanyUrl(gJob.applyUrl) && !isDirectCompanyUrl(existing.applyUrl)) {
        existing = { ...existing, applyUrl: gJob.applyUrl };
      }
      // Fill missing description
      if (!existing.description && gJob.description) {
        existing = { ...existing, description: gJob.description };
      }
      merged[idx] = existing;
      deduplicatedCount++;
      continue;
    }

    const newIdx = merged.length;
    merged.push({ ...gJob, _fromGemini: true, ingestionConfidence: gJob.ingestionConfidence });
    if (normalUrl) urlIndex.set(normalUrl, newIdx);
    ckIndex.set(ck, newIdx);
  }

  return { merged, deduplicatedCount };
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}
