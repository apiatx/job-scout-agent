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

import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SourceTrust     = 'ats_direct' | 'company_career' | 'aggregator' | 'unknown';
export type LinkConfidence  = 'high' | 'medium' | 'low' | 'unknown';
export type ValidationStatus = 'validated' | 'recovered' | 'suspicious' | 'failed' | 'pending';
export type PageType        = 'job_detail' | 'careers_home' | 'aggregator' | 'unknown';

export type AshbyMatchMethod = 'uuid_exact' | 'url_exact' | 'title_location' | 'title_similarity';

export interface FetchedJobData {
  title?:               string;
  company?:             string;
  location?:            string;
  description?:         string;
  employmentType?:      string;
  postedAt?:            string;
  pageType:             PageType;
  sourceApi:            string;         // 'greenhouse' | 'lever' | 'ashby' | 'html'
  resolvedUrl?:         string;         // canonical URL discovered by fetcher (Ashby jobUrl, etc.)
  matchMethod?:         AshbyMatchMethod; // how the Ashby posting was matched
  matchConfidence?:     number;           // 0-1 confidence score for the match
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
 * Greenhouse public JSON API by slug + job ID — called directly when slug is known.
 * If the specific jobId is not found AND jobTitle is provided, falls back to a
 * title-based search of the company's full job board (handles hallucinated IDs
 * returned by Gemini or stale IDs from aggregators).
 */
async function fetchFromGreenhouseApiBySlugAndId(slug: string, jobId: string, jobTitle?: string): Promise<FetchedJobData | null> {
  const apiUrls = [
    `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?content=true`,
    `https://job-boards.greenhouse.io/${slug}/jobs/${jobId}.json`,
    `https://boards.greenhouse.io/${slug}/jobs/${jobId}.json`,
  ];
  for (const apiUrl of apiUrls) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const res = await fetch(apiUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobScout/1.0)', Accept: 'application/json' },
        redirect: 'follow',
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json() as Record<string, unknown>;
      if (!data.title && !data.content) continue;
      const rawHtml = (data.content as string) ?? '';
      const desc = rawHtml
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim().slice(0, 6000);
      const location = (data.location as { name?: string } | undefined)?.name;
      const title = (data.title as string) || undefined;
      if (!title && !desc) continue;
      return { title, location, description: desc || undefined, postedAt: (data.updated_at as string) || undefined, pageType: 'job_detail', sourceApi: 'greenhouse' };
    } catch { /* try next */ }
  }

  // ── Title-based fallback: job ID was fake/stale — search full board by title ──
  if (!jobTitle) return null;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 12000);
    const boardRes = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobScout/1.0)', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!boardRes.ok) return null;
    const board = await boardRes.json() as { jobs?: Array<{ id: number; title: string; absolute_url: string; content?: string; location?: { name?: string } }> };
    const allJobs = board.jobs ?? [];
    if (allJobs.length === 0) return null;

    const titleLow  = jobTitle.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
    const titleWords = new Set(titleLow.split(/\s+/).filter(w => w.length > 2));
    let bestMatch: typeof allJobs[number] | null = null;
    let bestScore = 0;
    for (const j of allJobs) {
      const jLow = j.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
      if (jLow === titleLow) { bestMatch = j; bestScore = 999; break; }
      const overlap = jLow.split(/\s+/).filter(w => w.length > 2 && titleWords.has(w)).length;
      if (overlap > bestScore) { bestScore = overlap; bestMatch = j; }
    }
    if (!bestMatch || bestScore < 2) return null;

    console.log(`[GH-fallback] Matched "${bestMatch.title}" by title (score=${bestScore}) in ${slug}`);
    const rawHtml = (bestMatch.content as string) ?? '';
    const desc = rawHtml
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 6000);
    return {
      title:       bestMatch.title,
      location:    bestMatch.location?.name,
      description: desc || undefined,
      pageType:    'job_detail',
      sourceApi:   'greenhouse',
      resolvedUrl: bestMatch.absolute_url,
    };
  } catch {
    return null;
  }
}

/**
 * Greenhouse public JSON API — no auth required.
 * Uses the official boards-api.greenhouse.io/v1/boards/{co}/jobs/{id}?content=true endpoint.
 * Also attempts the legacy boards.greenhouse.io/{co}/jobs/{id}.json as fallback.
 * Pass jobTitle to enable title-based board search when the job ID is stale/hallucinated.
 */
async function fetchFromGreenhouseApi(url: string, jobTitle?: string): Promise<FetchedJobData | null> {
  // Extract slug + ID from standard greenhouse.io URL path
  const match = url.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  if (!match) return null;
  const [, company, jobId] = match;
  return fetchFromGreenhouseApiBySlugAndId(company, jobId, jobTitle);
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

// ── Ashby matcher constants ────────────────────────────────────────────────────

/**
 * Role-level words that carry strong semantic meaning in job titles.
 * A substitution of one of these for another is penalised heavily —
 * e.g. "Strategic" ↔ "Enterprise", "Senior" ↔ "Mid-Market" etc.
 */
const ROLE_LEVEL_WORDS: readonly string[] = [
  'strategic', 'enterprise', 'senior', 'mid-market', 'midmarket',
  'director', 'manager', 'principal', 'lead', 'junior', 'associate',
  'vp', 'president', 'head', 'staff', 'founding',
];

/** Thresholds for each match strategy */
const ASHBY_THRESHOLDS = {
  title_location:  0.75,   // title words + location also matches → lower bar
  title_similarity: 0.85,  // title-only fallback → stricter
  role_substitution_penalty: 0.25, // per substituted role word
} as const;

/** Normalize text for matching: lowercase, strip punctuation, collapse spaces */
function normText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Normalize location to a rough region string for comparison */
function normLocation(s: string): string {
  return s.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Scores how well `apiTitle` matches `storedTitle` using word overlap
 * with a penalty for substituted role-level words.
 *
 * Returns a score in [0, 1]. Scores below the relevant threshold are rejected
 * by the caller.
 */
function scoreTitle(storedTitle: string, apiTitle: string): number {
  const normStored = normText(storedTitle);
  const normApi    = normText(apiTitle);

  const storedWords = normStored.split(' ').filter(w => w.length > 2);
  if (!storedWords.length) return 0;

  // Word overlap: fraction of stored words that appear anywhere in the API title
  const matchedWords = storedWords.filter(w => normApi.includes(w));
  const overlap = matchedWords.length / storedWords.length;

  // Role-word substitution penalty:
  // For each role word in storedTitle, check if the API title has a DIFFERENT role word instead
  const storedRoleWords = ROLE_LEVEL_WORDS.filter(r => normStored.includes(r));
  const apiRoleWords    = ROLE_LEVEL_WORDS.filter(r => normApi.includes(r));

  let penalty = 0;
  for (const r of storedRoleWords) {
    if (!normApi.includes(r)) {
      // Role word missing from API title
      if (apiRoleWords.some(ar => ar !== r)) {
        // A different role word is present — substitution
        penalty += ASHBY_THRESHOLDS.role_substitution_penalty;
      } else {
        // Role word simply absent — lighter penalty (it's already captured in overlap)
        penalty += 0.05;
      }
    }
  }

  return Math.max(0, overlap - penalty);
}

/** Extract the description from an Ashby API job record */
function extractAshbyDesc(job: Record<string, unknown>): string | undefined {
  const rawHtml  = (job.descriptionHtml  as string) ?? '';
  const rawPlain = (job.descriptionPlain as string) ?? '';
  if (rawHtml) {
    const stripped = rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
    return stripped || undefined;
  }
  return rawPlain.slice(0, 8000) || undefined;
}

/**
 * Core Ashby matching engine.
 *
 * Given a pre-fetched list of board jobs and inputs (stored URL, stored title,
 * stored location), runs the four matching strategies in priority order and
 * returns the best match with its method and confidence, or null if nothing
 * passes the required threshold.
 *
 * Priority:
 *   1. UUID exact     — posting id from stored URL matches job.id from API    → confidence 1.0
 *   2. URL exact      — stored URL matches job.jobUrl or job.applyUrl exactly  → confidence 1.0
 *   3. title+location — title score ≥ 0.75 AND location region overlaps        → confidence = score
 *   4. title-only     — title score ≥ 0.85, strict role-word check             → confidence = score
 */
function matchAshbyPosting(
  boardJobs: Record<string, unknown>[],
  postingIdFromUrl: string,
  storedUrl: string,
  storedTitle: string,
  storedLocation: string,
): { job: Record<string, unknown>; method: AshbyMatchMethod; confidence: number } | null {

  // ── Priority 1: UUID exact match ──────────────────────────────────────────
  if (postingIdFromUrl) {
    const byUuid = boardJobs.find(
      j => (j.id as string)?.toLowerCase() === postingIdFromUrl.toLowerCase()
    );
    if (byUuid) return { job: byUuid, method: 'uuid_exact', confidence: 1.0 };
  }

  // ── Priority 2: URL exact match ───────────────────────────────────────────
  // Normalise stored URL for comparison (strip /application suffix, strip query)
  const normStoredUrl = storedUrl.replace(/\/application(\?.*)?$/, '').replace(/\?.*$/, '').toLowerCase();
  const byUrl = boardJobs.find(j => {
    const jobUrl   = ((j.jobUrl   as string) ?? '').toLowerCase();
    const applyUrl = ((j.applyUrl as string) ?? '').replace(/\/application(\?.*)?$/, '').toLowerCase();
    return jobUrl === normStoredUrl || applyUrl === normStoredUrl;
  });
  if (byUrl) return { job: byUrl, method: 'url_exact', confidence: 1.0 };

  // ── Priority 3 & 4: title-based matching ─────────────────────────────────
  // Score all jobs, tracking both title score and location match
  const normStoredLoc = normLocation(storedLocation);

  type Candidate = { job: Record<string, unknown>; titleScore: number; locMatch: boolean };
  const candidates: Candidate[] = boardJobs.map(j => {
    const apiTitle   = (j.title    as string) ?? '';
    const apiLoc     = (j.location as string) ?? '';
    const titleScore = scoreTitle(storedTitle, apiTitle);
    // Location match: at least one significant location word shared
    const normApiLoc  = normLocation(apiLoc);
    const locWords    = normStoredLoc.split(' ').filter(w => w.length > 3 && w !== 'remote');
    const locMatch    = locWords.length > 0
      ? locWords.some(w => normApiLoc.includes(w))
      : normStoredLoc.includes('remote') && normApiLoc.includes('remote');
    return { job: j, titleScore, locMatch };
  });

  // Best by title score
  candidates.sort((a, b) => b.titleScore - a.titleScore);
  const best = candidates[0];
  if (!best) return null;

  // Priority 3: title + location
  if (best.locMatch && best.titleScore >= ASHBY_THRESHOLDS.title_location) {
    return { job: best.job, method: 'title_location', confidence: Math.min(1, best.titleScore * 1.05) };
  }

  // Priority 4: title-only (stricter threshold)
  if (best.titleScore >= ASHBY_THRESHOLDS.title_similarity) {
    return { job: best.job, method: 'title_similarity', confidence: best.titleScore };
  }

  return null;
}

// ── Public Ashby API fetcher ────────────────────────────────────────────────

/**
 * Fetches the Ashby job board ONCE and runs the hardened 4-priority matcher.
 * Used by Phase A and by the generic dispatcher.
 *
 * Endpoint: GET https://api.ashbyhq.com/posting-api/job-board/{JOB_BOARD_NAME}
 * URL pattern: jobs.ashbyhq.com/{JOB_BOARD_NAME}/{posting-id}[/application]
 */
export async function fetchFromAshbyApiWithTitle(
  url: string,
  storedTitle: string,
  storedLocation = '',
): Promise<FetchedJobData | null> {
  // Extract board name and posting-id from URL
  const urlMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)(?:\/([^/?#]+))?/i);
  if (!urlMatch) return null;
  const boardName      = urlMatch[1];
  const postingIdRaw   = urlMatch[2]?.split('/')[0] ?? '';
  // Strip trailing ?… from posting ID
  const postingIdFromUrl = postingIdRaw.replace(/\?.*$/, '');

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const res = await fetch(
      `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(boardName)}`,
      { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobScout/1.0)', 'Accept': 'application/json' }, signal: ctrl.signal },
    );
    clearTimeout(timer);
    if (!res.ok) return null;

    const data = await res.json() as Record<string, unknown>;
    const boardJobs = (data.jobs ?? data.jobPostings ?? []) as Record<string, unknown>[];
    if (!boardJobs.length) return null;

    const match = matchAshbyPosting(boardJobs, postingIdFromUrl, url, storedTitle, storedLocation);
    if (!match) return null;

    const { job: matched, method, confidence } = match;

    return {
      title:           (matched.title    as string)  || undefined,
      location:        (matched.location as string)  || undefined,
      description:     extractAshbyDesc(matched),
      pageType:        'job_detail',
      sourceApi:       'ashby',
      resolvedUrl:     (matched.jobUrl   as string)  || undefined,
      matchMethod:     method,
      matchConfidence: Math.round(confidence * 1000) / 1000,
    };
  } catch {
    return null;
  }
}

/**
 * Main dispatcher: fetches real job data from a canonical URL.
 * Tries API-first for known ATS platforms, falls back to HTML parsing.
 * Pass jobTitle to enable title-based board search when the Greenhouse job ID is stale/hallucinated.
 */
export async function fetchJobDescriptionFromCanonicalUrl(url: string, jobTitle?: string): Promise<FetchedJobData | null> {
  const lower = url.toLowerCase();
  try {
    if (lower.includes('greenhouse.io')) {
      const result = await fetchFromGreenhouseApi(url, jobTitle);
      if (result?.description) return result;
    }
    if (lower.includes('lever.co')) {
      const result = await fetchFromLeverApi(url);
      if (result?.description) return result;
    }
    if (lower.includes('ashbyhq.com')) {
      const result = await fetchFromAshbyApiWithTitle(url, '', '');
      if (result?.description) return result;
    }
    // For all other ATSes/company pages: HTML fetch
    return await fetchFromHtml(url);
  } catch {
    return null;
  }
}

// ── Pre-scoring enrichment (synchronous, called inline before Claude) ──────────

/**
 * Enriches newly discovered jobs with real descriptions BEFORE Claude scores them.
 * Only runs for jobs with direct Greenhouse, Lever, or Ashby URLs and missing/short
 * descriptions (< 200 chars). Mutates the jobs array in place. Fast: runs in parallel
 * batches of 10, no Gemini, no rate limits.
 *
 * Called inline in the scout pipeline before scoreJobsWithClaude().
 */
export async function enrichJobsPreScoring(
  jobs: Array<{ applyUrl: string; description?: string | null; title?: string; company?: string; location?: string }>,
): Promise<{ enriched: number; skipped: number }> {
  // Target jobs with ATS URLs or gh_jid embedded in company career page
  const targets = jobs.filter(j => {
    const url = (j.applyUrl ?? '').toLowerCase();
    const isAts = url.includes('greenhouse.io') || url.includes('lever.co') || url.includes('ashbyhq.com') || url.includes('gh_jid=');
    const descLen = (j.description ?? '').replace(/<[^>]+>/g, '').trim().length;
    return isAts && descLen < 200;
  });

  if (!targets.length) return { enriched: 0, skipped: jobs.length };

  let enriched = 0;
  const CONCURRENCY = 10;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (job) => {
      try {
        let fetched: FetchedJobData | null;
        const url = job.applyUrl ?? '';
        const ghJidMatch = url.match(/[?&]gh_jid=(\d+)/);
        if (ghJidMatch && job.company) {
          // Derive slug from company name as best-effort (works for simple names like databricks)
          const slug = job.company.toLowerCase().replace(/[^a-z0-9]/g, '');
          fetched = await fetchFromGreenhouseApiBySlugAndId(slug, ghJidMatch[1]);
        } else if (url.toLowerCase().includes('ashbyhq.com')) {
          fetched = await fetchFromAshbyApiWithTitle(url, job.title ?? '');
        } else {
          fetched = await fetchJobDescriptionFromCanonicalUrl(url, job.title ?? undefined);
        }
        if (fetched?.description && !isListingPageDescription(fetched.description)) {
          job.description = fetched.description;
          enriched++;
        }
      } catch { /* non-fatal */ }
    }));
  }

  return { enriched, skipped: jobs.length - targets.length };
}

// ── Claude URL resolver (replaces Gemini) ─────────────────────────────────────

/**
 * Uses Claude Haiku with web_search to find the canonical live posting URL for a job.
 * Replaces the previous Gemini-based resolver; uses claude-haiku-4-5 + web_search_20250305.
 */
export async function resolveJobUrlWithGemini(
  title: string,
  company: string,
  location: string,
  currentUrl?: string,
): Promise<{ url: string; source: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });

  const currentTrust = currentUrl ? classifySourceTrust(currentUrl) : 'unknown';
  const isUpgrade = currentTrust === 'aggregator';

  const prompt = `Find the current, live direct job posting URL for this role:
Job Title: "${title}"
Company: "${company}"
Location: "${location || 'US'}"
${isUpgrade ? `The current link is an aggregator — find the company's direct ATS or careers page posting instead.` : ''}

Prioritize in this order:
1. boards.greenhouse.io / jobs.lever.co / jobs.ashbyhq.com / myworkdayjobs.com
2. The company's own careers page (direct job posting, not careers home)
3. Any reliable direct source

Use web search to find the URL. Return ONLY the single best URL on its own line, nothing else. If not found, return: NOT_FOUND`;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      tools: [{ type: 'web_search_20250305' as const, name: 'web_search', max_uses: 3 }],
      messages: [{ role: 'user', content: prompt }],
    });

    let text = '';
    for (const block of response.content) {
      if (block.type === 'text') text += block.text;
    }
    text = text.trim();

    if (!text || text.includes('NOT_FOUND')) return null;

    const urlMatch = text.match(/https?:\/\/[^\s\n"'<>()\],;]+/);
    if (!urlMatch) return null;
    const candidateUrl = urlMatch[0].replace(/[.,;!?)]+$/, '');

    const candidateTrust = classifySourceTrust(candidateUrl);
    if (candidateTrust === 'aggregator') return null;

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
        const sourceLabel = candidateTrust === 'ats_direct'    ? 'claude_resolved_ats'
          : candidateTrust === 'company_career'                ? 'claude_resolved_company'
          :                                                      'claude_resolved';
        return { url: candidateUrl, source: sourceLabel };
      }
    } catch { /* not live */ }
  } catch (e) {
    console.warn(`[Recovery] Claude web search failed: ${e instanceof Error ? e.message : e}`);
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
         description                = COALESCE($8, description),
         resolved_location          = COALESCE($9, resolved_location),
         resolved_metadata_json     = COALESCE($10, resolved_metadata_json),
         metadata_last_verified_at  = NOW(),
         url_ok                     = CASE WHEN $4 = true THEN true ELSE url_ok END,
         url_checked_at             = CASE WHEN $4 = true THEN NOW() ELSE url_checked_at END,
         page_type                  = COALESCE($11, page_type),
         recovery_match_method      = COALESCE($13, recovery_match_method),
         recovery_match_confidence  = COALESCE($14, recovery_match_confidence)
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
        sourceApi:       fetchedData.sourceApi,
        pageType:        fetchedData.pageType,
        postedAt:        fetchedData.postedAt,
        matchMethod:     fetchedData.matchMethod,
        matchConfidence: fetchedData.matchConfidence,
        fetchedAt:       new Date().toISOString(),
      }) : null,
      fetchedData?.pageType || null,
      jobId,
      fetchedData?.matchMethod  ?? null,
      fetchedData?.matchConfidence != null ? fetchedData.matchConfidence : null,
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
    // Covers two cases:
    //  1. Jobs with direct ATS URLs (greenhouse.io, lever.co, etc.)
    //  2. Jobs on company career pages that embed a Greenhouse job ID via ?gh_jid=
    // Excludes permanently-failed jobs to avoid repeated no-op retries.
    const { rows: atsJobs } = await pool.query(`
      SELECT j.id, j.title, j.company, j.location, j.apply_url, j.description,
             j.match_score, j.url_ok, j.canonical_url, j.canonical_source,
             j.validation_status,
             c.ats_slug AS company_ats_slug, c.ats_type AS company_ats_type
      FROM jobs j
      LEFT JOIN companies c ON LOWER(c.name) = LOWER(j.company) AND c.ats_slug IS NOT NULL
      WHERE j.validation_status NOT IN ('validated', 'recovered', 'failed')
        AND (j.description IS NULL OR LENGTH(j.description) < 120)
        AND (
          -- Standard ATS direct links (greenhouse/lever/ashby with real URL)
          (j.canonical_source = 'ats_direct' AND j.url_ok IS NOT FALSE)
          -- Company career pages embedding a Greenhouse job ID via ?gh_jid=
          OR (j.apply_url LIKE '%gh_jid=%' AND j.canonical_source IN ('original', 'company_career'))
        )
        ${scopeClause}
      ORDER BY j.match_score DESC NULLS LAST
      LIMIT 60
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

            let fetchedData: FetchedJobData | null = null;

            // Check for ?gh_jid= style Greenhouse embedding (e.g. Databricks career page)
            const ghJidMatch = url.match(/[?&]gh_jid=(\d+)/);
            if (ghJidMatch) {
              const jobId = ghJidMatch[1];
              const slug: string = job.company_ats_slug ?? job.company?.toLowerCase().replace(/\s+/g, '');
              if (slug) {
                fetchedData = await fetchFromGreenhouseApiBySlugAndId(slug, jobId, job.title ?? undefined);
              }
            } else if (url.toLowerCase().includes('ashbyhq.com')) {
              fetchedData = await fetchFromAshbyApiWithTitle(url, job.title ?? '', job.location ?? '');
            } else {
              fetchedData = await fetchJobDescriptionFromCanonicalUrl(url, job.title ?? undefined);
            }

            // For gh_jid jobs, use the canonical Greenhouse URL as the recovered URL
            let effectiveCanonicalUrl = fetchedData?.resolvedUrl ?? url;
            if (ghJidMatch && fetchedData?.description && job.company_ats_slug) {
              const ghUrl = `https://job-boards.greenhouse.io/${job.company_ats_slug}/jobs/${ghJidMatch[1]}`;
              effectiveCanonicalUrl = ghUrl;
            }

            const canonSrc = (ghJidMatch && fetchedData?.description) ? 'ats_direct' : (job.canonical_source ?? 'ats_direct');
            const status = await writeRecoveryResult(
              pool, job.id, effectiveCanonicalUrl, canonSrc,
              false, fetchedData, job.apply_url ?? '',
            );
            if (status === 'validated' || status === 'recovered') {
              aOk++;
              const descLen = fetchedData?.description?.length ?? 0;
              const urlNote = fetchedData?.resolvedUrl ? ` [URL→${fetchedData.resolvedUrl.slice(0,60)}]` : '';
              console.log(`[Recovery Phase A] ✓ ${job.company} "${(job.title as string).slice(0, 40)}" → ${status} (${descLen} chars)${urlNote}`);
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

    // ── PHASE B: Claude URL resolver for aggregator + broken links (sequential) ─
    const hasClaude = !!process.env.ANTHROPIC_API_KEY?.trim();
    const { rows: geminiJobs } = await pool.query(`
      SELECT j.id, j.title, j.company, j.location, j.apply_url, j.description,
             j.match_score, j.url_ok, j.canonical_url, j.canonical_source,
             j.validation_status, j.was_resolved_by_gemini
      FROM jobs j
      WHERE j.validation_status NOT IN ('validated', 'recovered')
        AND j.was_resolved_by_gemini IS NOT TRUE
        AND (
          -- Broken links (any source)
          j.url_ok = false
          -- Aggregator links that need upgrading to direct ATS
          OR j.canonical_source IN ('linkedin', 'indeed', 'glassdoor', 'ziprecruiter', 'aggregator')
          -- Company career pages (canonical_source='original') — high-scoring jobs only
          OR (j.canonical_source = 'original' AND j.match_score >= 65)
        )
        AND (j.match_score >= 55 OR j.match_score IS NULL)
        ${scopeClause}
      ORDER BY j.match_score DESC NULLS LAST
      LIMIT 20
    `, params);

    if (!geminiJobs.length) {
      console.log(`[Recovery Phase B] No aggregator/broken-link jobs to resolve`);
      console.log(`──────────────────────────────────────────────────────────────\n`);
      return;
    }

    console.log(`[Recovery Phase B] ${geminiJobs.length} aggregator/broken jobs | Claude: ${hasClaude ? 'enabled' : 'disabled'}`);
    let bUpgraded = 0, bDescFetched = 0, bFailed = 0;

    for (const job of geminiJobs) {
      try {
        let canonicalUrl: string = job.canonical_url ?? job.apply_url ?? '';
        let canonicalSource: string = job.canonical_source ?? 'original';
        let usedGemini = false;

        if (hasClaude) {
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
          // Pace Claude calls to avoid rate limits
          await new Promise(r => setTimeout(r, 1000));
        }

        // Even if Gemini didn't improve the URL, try fetching the current URL
        const fetchedData = canonicalUrl ? await fetchJobDescriptionFromCanonicalUrl(canonicalUrl, job.title as string ?? undefined) : null;

        // If the Greenhouse title-based fallback returned a real URL (resolvedUrl),
        // use that as the effective canonical URL — it's the real posting, not the fake ID.
        const effectiveCanonicalUrl = fetchedData?.resolvedUrl ?? canonicalUrl;
        const effectiveCanonicalSource = fetchedData?.resolvedUrl ? 'greenhouse-board-title-match' : canonicalSource;

        const status = await writeRecoveryResult(
          pool, job.id, effectiveCanonicalUrl, effectiveCanonicalSource, usedGemini, fetchedData, job.apply_url ?? '',
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
