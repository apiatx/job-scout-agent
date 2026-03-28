/**
 * Gemini Discovery Service
 *
 * Uses Gemini API with Google Search grounding to find additional job listings
 * and direct company career pages that JobSpy may miss. Results are normalized
 * into the same ScrapedJob shape used by the rest of the pipeline.
 *
 * Environment variables:
 *   GEMINI_API_KEY           — required; skipped gracefully if absent
 *   GEMINI_MODEL             — default: gemini-2.0-flash
 *   GEMINI_ENABLE_SEARCH     — default: true  (set to "false" to disable)
 *   GEMINI_MAX_RESULTS       — default: 30    (max jobs returned across all queries)
 *   GEMINI_TIMEOUT_SECONDS   — default: 60
 *
 * Future hook: GEMINI_DEEP_RESEARCH=true will enable a premium multi-step company
 * research mode (not implemented yet — abstraction point left here).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import type { ScrapedJob } from './scraper.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GeminiJob extends ScrapedJob {
  source: string;              // always 'Gemini' for pipeline-discovered jobs
  geminiGroundingMetadata?: GeminiGroundingMetadata;
  geminiSources?: GeminiSource[];
  geminiWebSearchQueries?: string[];
  ingestionConfidence: number; // 0–1; how confident we are this is a real current listing
}

export interface GeminiGroundingMetadata {
  groundingChunks?: Array<{
    web?: { uri: string; title?: string };
  }>;
  searchEntryPoint?: {
    renderedContent?: string;
  };
  webSearchQueries?: string[];
  groundingSupports?: Array<{
    segment?: { text?: string };
    groundingChunkIndices?: number[];
    confidenceScores?: number[];
  }>;
}

export interface GeminiSource {
  uri: string;
  title?: string;
}

export interface GeminiDiscoveryCriteria {
  target_roles: string[];
  locations: string[];
  work_type: string;         // 'remote' | 'hybrid' | 'onsite' | 'any'
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
  skipped: boolean;          // true if Gemini was skipped (not configured, disabled, etc.)
  skipReason?: string;
}

// ── Raw parsed record from Gemini's JSON output ───────────────────────────────

interface RawGeminiJobRecord {
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  apply_url?: string;        // alternate key Gemini may use
  description?: string;
  salary?: string;
  remote_type?: string;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runGeminiJobDiscovery(
  criteria: GeminiDiscoveryCriteria
): Promise<GeminiDiscoveryResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.log('[Gemini] GEMINI_API_KEY not set — skipping Gemini discovery');
    return { jobs: [], queriesUsed: [], totalGroundingSources: 0, skipped: true, skipReason: 'GEMINI_API_KEY not configured' };
  }

  const enableSearch = (process.env.GEMINI_ENABLE_SEARCH ?? 'true').toLowerCase() !== 'false';
  if (!enableSearch) {
    console.log('[Gemini] GEMINI_ENABLE_SEARCH=false — skipping Gemini discovery');
    return { jobs: [], queriesUsed: [], totalGroundingSources: 0, skipped: true, skipReason: 'GEMINI_ENABLE_SEARCH=false' };
  }

  const modelName    = process.env.GEMINI_MODEL ?? 'gemini-2.0-flash';
  const maxResults   = parseInt(process.env.GEMINI_MAX_RESULTS ?? '30', 10);
  const timeoutMs    = parseInt(process.env.GEMINI_TIMEOUT_SECONDS ?? '60', 10) * 1000;

  console.log(`\n──── GEMINI DISCOVERY ──────────────────────────────────────`);
  console.log(`[Gemini] Model: ${modelName} | Max results: ${maxResults} | Timeout: ${timeoutMs / 1000}s`);

  const genai = new GoogleGenerativeAI(apiKey);

  // Build the search prompt using user criteria
  const prompt = buildSearchPrompt(criteria, maxResults);

  // Log which roles / locations we're searching for
  console.log(`[Gemini] Searching for: ${criteria.target_roles.slice(0, 3).join(', ')}${criteria.target_roles.length > 3 ? '...' : ''}`);
  console.log(`[Gemini] Locations: ${criteria.locations.join(', ') || 'Remote / US'}`);

  try {
    const model = genai.getGenerativeModel({
      model: modelName,
      // Google Search grounding — the correct tool name for Gemini 2.0+ models
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: [{ googleSearch: {} } as any],
    });

    // Wrap in a timeout race
    const resultPromise = model.generateContent(prompt);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Gemini timeout after ${timeoutMs / 1000}s`)), timeoutMs)
    );

    const result = await Promise.race([resultPromise, timeoutPromise]);
    const response = result.response;
    const text = response.text();

    // Extract grounding metadata from the first candidate
    const candidate = response.candidates?.[0];
    // Gemini puts grounding metadata on the candidate object
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawGrounding = (candidate as any)?.groundingMetadata as GeminiGroundingMetadata | undefined;

    const groundingMeta: GeminiGroundingMetadata = {
      groundingChunks:    rawGrounding?.groundingChunks    ?? [],
      searchEntryPoint:   rawGrounding?.searchEntryPoint,
      webSearchQueries:   rawGrounding?.webSearchQueries   ?? [],
      groundingSupports:  rawGrounding?.groundingSupports  ?? [],
    };

    const sources: GeminiSource[] = (groundingMeta.groundingChunks ?? [])
      .filter(c => c.web?.uri)
      .map(c => ({ uri: c.web!.uri, title: c.web!.title }));

    const webSearchQueriesUsed = groundingMeta.webSearchQueries ?? [];

    console.log(`[Gemini] Search complete — ${sources.length} grounding sources, queries: ${JSON.stringify(webSearchQueriesUsed)}`);

    // Parse job listings from the response text
    const rawJobs = parseJobsFromText(text);
    console.log(`[Gemini] Parsed ${rawJobs.length} raw job records from response`);

    // Normalize and filter
    const jobs = normalizeGeminiJobs(rawJobs, groundingMeta, sources, webSearchQueriesUsed, criteria);

    // Limit to max
    const limited = jobs.slice(0, maxResults);
    console.log(`[Gemini] ${limited.length} valid normalized jobs after filtering (${jobs.length - limited.length} trimmed)`);
    console.log(`───────────────────────────────────────────────────────────`);

    return {
      jobs: limited,
      queriesUsed: webSearchQueriesUsed,
      totalGroundingSources: sources.length,
      skipped: false,
    };

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Gemini] Discovery failed: ${msg}`);
    console.log(`[Gemini] Continuing with JobSpy results only`);
    console.log(`───────────────────────────────────────────────────────────`);
    return { jobs: [], queriesUsed: [], totalGroundingSources: 0, skipped: true, skipReason: msg };
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildSearchPrompt(criteria: GeminiDiscoveryCriteria, maxResults: number): string {
  const roles = criteria.target_roles.slice(0, 8).join(', ') || 'account executive, sales manager';
  const locations = criteria.locations.join(', ') || 'Remote';
  const workType = criteria.work_type === 'remote' ? 'remote' : criteria.work_type === 'hybrid' ? 'remote or hybrid' : 'any location';
  const mustHave = criteria.must_have.slice(0, 6).join(', ');
  const industries = criteria.industries.slice(0, 4).join(', ');
  const salaryNote = criteria.min_salary ? `Minimum salary: $${criteria.min_salary.toLocaleString()}` : '';

  return `You are a job search assistant. Use Google Search to find currently open job listings that match these exact criteria:

TARGET ROLES: ${roles}
LOCATION/WORK TYPE: ${workType} — preferred locations: ${locations}
KEY SKILLS/KEYWORDS: ${mustHave || 'enterprise sales, SaaS, B2B'}
${industries ? `INDUSTRIES: ${industries}` : ''}
${salaryNote}

Search job boards and company career pages including:
- site:greenhouse.io OR site:lever.co OR site:ashbyhq.com OR site:jobs.ashbyhq.com
- site:boards.greenhouse.io OR site:jobs.lever.co
- site:workday.com OR site:myworkdayjobs.com
- Direct company careers pages (e.g., company.com/careers or company.com/jobs)
- LinkedIn job listings where findable

Focus on finding DIRECT job application URLs (not aggregator summary pages). Prefer greenhouse.io, lever.co, ashbyhq.com, or company career pages over LinkedIn/Indeed.

For each job found, I need:
- Exact job title
- Company name
- Location (or "Remote" if remote)
- Direct application URL
- Brief description (1-2 sentences from the posting if available)
- Salary range if visible

Output your findings as a JSON array between the markers JOBS_START and JOBS_END. Each object must have these fields:
{
  "title": "...",
  "company": "...",
  "location": "...",
  "url": "...",
  "description": "...",
  "salary": "..."
}

Find up to ${maxResults} unique, currently open positions. Only include roles clearly matching the target roles list. Do not include expired, filled, or clearly irrelevant roles.

JOBS_START
[your JSON array here]
JOBS_END`;
}

// ── Response parser ───────────────────────────────────────────────────────────

/**
 * Extracts the JSON job array from Gemini's free-form response text.
 * Looks for the JOBS_START / JOBS_END markers first, then falls back to
 * searching for a raw JSON array in the response.
 */
function parseJobsFromText(text: string): RawGeminiJobRecord[] {
  // Strategy 1: Look for our explicit markers
  const markerMatch = text.match(/JOBS_START\s*([\s\S]*?)\s*JOBS_END/);
  if (markerMatch) {
    const jsonStr = markerMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonStr);
      if (Array.isArray(parsed)) return parsed as RawGeminiJobRecord[];
    } catch {
      // Fall through to strategy 2
    }
  }

  // Strategy 2: Find any JSON array in the response (largest one)
  const jsonMatches: string[] = (text.match(/\[[\s\S]*?\]/g) as string[] | null) ?? [];
  for (const candidate of jsonMatches.sort((a, b) => b.length - a.length)) {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0 && (parsed[0].title || parsed[0].url)) {
        return parsed as RawGeminiJobRecord[];
      }
    } catch {
      // Continue
    }
  }

  // Strategy 3: Try to parse any JSON object containing a "jobs" key
  const objMatch = text.match(/\{[\s\S]*?"jobs"[\s\S]*?\}/);
  if (objMatch) {
    try {
      const parsed = JSON.parse(objMatch[0]);
      if (Array.isArray(parsed.jobs)) return parsed.jobs as RawGeminiJobRecord[];
    } catch {
      // Fall through
    }
  }

  console.log('[Gemini] Could not parse structured job data from response. Raw preview:', text.slice(0, 300));
  return [];
}

// ── Normalizer ────────────────────────────────────────────────────────────────

const KNOWN_ATS_DOMAINS = [
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'jobs.ashbyhq.com',
  'boards.greenhouse.io', 'jobs.lever.co', 'myworkdayjobs.com',
  'icims.com', 'smartrecruiters.com', 'bamboohr.com', 'rippling.com',
];

/** True when the URL appears to be a direct company job posting (not an aggregator) */
function isDirectCompanyUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    // Known ATS domains are direct — they host the actual job posting
    if (KNOWN_ATS_DOMAINS.some(d => host.endsWith(d))) return true;
    // LinkedIn / Indeed / Glassdoor = aggregators
    if (['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com'].some(d => host.endsWith(d))) return false;
    // Anything else that looks like a careers/jobs path on a company domain
    return true;
  } catch {
    return false;
  }
}

/** Assign a confidence score based on data quality */
function scoreConfidence(job: RawGeminiJobRecord): number {
  let score = 0.5; // base
  if (job.url && job.url.startsWith('http')) score += 0.1;
  if (isDirectCompanyUrl(job.url ?? ''))     score += 0.15;
  if (job.description && job.description.length > 50) score += 0.1;
  if (job.title && job.title.length > 5)    score += 0.05;
  if (job.company && job.company.length > 1) score += 0.05;
  if (job.salary)                            score += 0.05;
  return Math.min(1, score);
}

function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    // Strip common tracking params
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','ref','referral'].forEach(p => u.searchParams.delete(p));
    return u.href.replace(/\/$/, '');
  } catch {
    return rawUrl.trim();
  }
}

function normalizeGeminiJobs(
  rawJobs: RawGeminiJobRecord[],
  groundingMeta: GeminiGroundingMetadata,
  sources: GeminiSource[],
  webSearchQueries: string[],
  criteria: GeminiDiscoveryCriteria,
): GeminiJob[] {
  const seen = new Set<string>();
  const results: GeminiJob[] = [];

  for (const raw of rawJobs) {
    // Require at minimum title + company + url
    const url = (raw.url ?? raw.apply_url ?? '').trim();
    const title = (raw.title ?? '').trim();
    const company = (raw.company ?? '').trim();

    if (!url || !title || !company) continue;
    if (!url.startsWith('http')) continue;

    // Dedup within Gemini results (by normalized URL or company+title)
    const normalUrl = normalizeUrl(url);
    const dedupeKey = normalUrl || `${company.toLowerCase()}::${title.toLowerCase()}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const job: GeminiJob = {
      title,
      company,
      location: (raw.location ?? '').trim() || guessLocation(criteria),
      salary:   raw.salary ?? undefined,
      applyUrl: normalUrl || url,
      description: raw.description ?? undefined,
      source:   'Gemini',
      geminiGroundingMetadata: groundingMeta,
      geminiSources:           sources,
      geminiWebSearchQueries:  webSearchQueries,
      ingestionConfidence:     scoreConfidence(raw),
    };

    results.push(job);
  }

  return results;
}

/** Guess a reasonable location string from criteria when Gemini omits it */
function guessLocation(criteria: GeminiDiscoveryCriteria): string {
  if (criteria.work_type === 'remote') return 'Remote';
  if (criteria.locations.length > 0) return criteria.locations[0];
  return 'Unknown';
}

// ── Deduplication helper (used by the pipeline in index.ts) ──────────────────

export function deduplicateJobLists(
  primary: Array<ScrapedJob & { source: string; _fromJobSpy?: boolean }>,
  gemini: GeminiJob[]
): { merged: Array<ScrapedJob & { source: string; _fromJobSpy?: boolean; _fromGemini?: boolean; ingestionConfidence?: number }>; deduplicatedCount: number } {
  const normalizedPrimaryUrls = new Map<string, number>(); // normalUrl → index
  const companyTitleKeys = new Map<string, number>();       // "company::title" → index

  // Index primary jobs
  for (let i = 0; i < primary.length; i++) {
    const j = primary[i];
    const normalUrl = normalizeUrl(j.applyUrl);
    if (normalUrl) normalizedPrimaryUrls.set(normalUrl, i);

    const ck = `${j.company.toLowerCase().trim()}::${normalizeTitle(j.title)}`;
    companyTitleKeys.set(ck, i);
  }

  const merged: Array<ScrapedJob & { source: string; _fromJobSpy?: boolean; _fromGemini?: boolean; ingestionConfidence?: number }> = [...primary];
  let deduplicatedCount = 0;

  for (const gJob of gemini) {
    const normalUrl = normalizeUrl(gJob.applyUrl);
    const ck = `${gJob.company.toLowerCase().trim()}::${normalizeTitle(gJob.title)}`;

    // Check if this job already exists in primary results
    const existsByUrl = normalUrl && normalizedPrimaryUrls.has(normalUrl);
    const existsByCompanyTitle = companyTitleKeys.has(ck);

    if (existsByUrl || existsByCompanyTitle) {
      // Duplicate found — potentially enrich the existing record with description
      const existingIdx = existsByUrl ? normalizedPrimaryUrls.get(normalUrl)! : companyTitleKeys.get(ck)!;
      const existing = merged[existingIdx];
      // Enrich: if Gemini has a description and the existing record doesn't, use it
      if (!existing.description && gJob.description) {
        merged[existingIdx] = { ...existing, description: gJob.description };
      }
      // Prefer direct company URL over aggregator URL
      if (gJob.applyUrl && isDirectCompanyUrl(gJob.applyUrl) && !isDirectCompanyUrl(existing.applyUrl)) {
        merged[existingIdx] = { ...merged[existingIdx], applyUrl: gJob.applyUrl };
      }
      deduplicatedCount++;
      continue;
    }

    // Genuinely new job from Gemini — add to merged list
    merged.push({
      ...gJob,
      _fromGemini: true,
      ingestionConfidence: gJob.ingestionConfidence,
    });

    // Index the new entry
    const newIdx = merged.length - 1;
    if (normalUrl) normalizedPrimaryUrls.set(normalUrl, newIdx);
    companyTitleKeys.set(ck, newIdx);
  }

  return { merged, deduplicatedCount };
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
