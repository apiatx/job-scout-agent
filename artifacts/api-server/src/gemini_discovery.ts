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
  /** When set, discovery focuses exclusively on these named companies */
  company_focus?: string[];
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

  console.log(`\n──── JOB DISCOVERY ─────────────────────────────────────────`);
  console.log(`[Discovery] Max results: ${maxResults} | Timeout: ${timeoutMs / 1000}s`);
  console.log(`[Discovery] Roles: ${criteria.target_roles.slice(0, 3).join(', ')}${criteria.target_roles.length > 3 ? '...' : ''}`);
  console.log(`[Discovery] Locations: ${criteria.locations.join(', ') || 'Remote / US'}`);

  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildSearchPrompt(criteria, maxResults);

  // ── Perplexity primary ────────────────────────────────────────────────
  const plxKey = process.env.PERPLEXITY_API_KEY?.trim();
  if (plxKey) {
    try {
      console.log('[Discovery] Trying Perplexity sonar-pro (LinkedIn + ATS, uncapped)');
      const plxPrompt = buildPerplexitySearchPrompt(criteria);
      const plxResp = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${plxKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'sonar-pro', messages: [{ role: 'user', content: plxPrompt }], max_tokens: 16000, temperature: 0.1 }),
      });
      if (plxResp.ok) {
        const plxData = await plxResp.json() as any;
        const text: string = plxData.choices?.[0]?.message?.content ?? '';
        const rawJobs = parseJobsFromText(text);
        if (rawJobs.length > 0) {
          const normalized = normalizeGeminiJobs(rawJobs, {}, [], [], criteria, 'Perplexity');
          const validated = await validateGreenhouseUrls(normalized);
          console.log(`[Discovery] Perplexity: ${validated.length} valid jobs (${rawJobs.length} parsed, no cap)`);
          console.log(`───────────────────────────────────────────────────────────`);
          return { jobs: validated, queriesUsed: [], totalGroundingSources: 0, modelUsed: 'perplexity/sonar-pro', skipped: false };
        }
        console.warn(`[Discovery] Perplexity returned 0 parseable jobs (${text.length} chars). Response preview: "${text.slice(0, 300)}"`);
        throw new Error(`Perplexity returned 0 parseable jobs (${text.length} chars)`);
      }
      const errBody = await plxResp.text().catch(() => '');
      throw new Error(`Perplexity HTTP ${plxResp.status}: ${errBody.slice(0, 120)}`);
    } catch (plxErr) {
      console.warn('[Discovery] Perplexity failed, falling back to Gemini:', plxErr instanceof Error ? plxErr.message.slice(0, 150) : plxErr);
    }
  }

  // ── Gemini fallback waterfall ─────────────────────────────────────────
  console.log(`[Discovery] Gemini chain: ${candidates.map(c => c.modelName).join(' → ')}`);
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

      const normalized = normalizeGeminiJobs(rawJobs, groundingMeta, sources, webSearchQueriesUsed, criteria);

      // Validate Greenhouse URLs — Gemini frequently hallucinates job IDs.
      // This hits the real public Greenhouse API and either confirms the URL,
      // finds the real job by title match, or drops the listing entirely.
      const validated = await validateGreenhouseUrls(normalized);
      const limited = validated.slice(0, maxResults);

      console.log(`[Gemini] ${limited.length} valid normalized jobs (${rawJobs.length} parsed, ${normalized.length - validated.length} GH-dropped, ${validated.length - limited.length} trimmed)`);
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

  // ── Company-focused mode (Career Intel / Pre-IPO targeted scan) ───────────
  if (criteria.company_focus && criteria.company_focus.length > 0) {
    const companyList = criteria.company_focus.slice(0, 20).join(', ');
    return `You are a job search assistant. Use Google Search to find currently open job listings at THESE SPECIFIC COMPANIES ONLY:

COMPANIES TO SEARCH: ${companyList}

TARGET ROLES (must match one of these): ${roles}
WORK TYPE: ${workType} — preferred locations: ${locations}
KEY SKILLS: ${mustHave || 'enterprise sales, SaaS, B2B'}
${salaryNote}

For EACH company in the list above, search its direct careers page, Greenhouse, Lever, Ashby, or Workday job board. Use queries like:
- "[company name] site:greenhouse.io OR site:lever.co OR site:ashbyhq.com"
- "[company name] careers ${roles.split(',')[0]?.trim() || 'sales'} open roles"

For each job found, I need:
- Exact job title
- Company name (must be one of the companies listed above)
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
- Find up to ${maxResults} unique, currently open positions across the listed companies
- ONLY include jobs from companies explicitly listed above — do not add others
- Only include roles that match the target roles list
- Do NOT include expired, filled, or clearly irrelevant roles
- Prefer direct ATS URLs (greenhouse/lever/ashby/workday) over LinkedIn/Indeed links
- Do not fabricate jobs — only include roles you can verify exist via search`;
  }

  // ── Standard broad search mode ────────────────────────────────────────────
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

// ── Perplexity-specific prompt (LinkedIn-first, uncapped) ─────────────────────

function buildPerplexitySearchPrompt(criteria: GeminiDiscoveryCriteria): string {
  const roles      = criteria.target_roles.slice(0, 10).join(', ') || 'account executive, sales manager';
  const locations  = criteria.locations.join(', ') || 'Remote';
  const workType   = criteria.work_type === 'remote'  ? 'remote only'
                   : criteria.work_type === 'hybrid'  ? 'remote or hybrid'
                   : criteria.work_type === 'onsite'  ? 'on-site'
                   : 'remote, hybrid, or on-site';
  const mustHave   = criteria.must_have.slice(0, 8).join(', ');
  const industries = criteria.industries.slice(0, 5).join(', ');
  const salaryNote = criteria.min_salary ? `Minimum salary: $${criteria.min_salary.toLocaleString()}` : '';

  // ── Company-focused mode ──────────────────────────────────────────────────
  if (criteria.company_focus && criteria.company_focus.length > 0) {
    const companyList = criteria.company_focus.slice(0, 20).join(', ');
    return `You are a job search assistant with live web access. Search LinkedIn Jobs, company careers pages, Greenhouse, Lever, and Ashby for currently open roles at THESE SPECIFIC COMPANIES: ${companyList}

TARGET ROLES (must match one): ${roles}
WORK TYPE: ${workType} | LOCATIONS: ${locations}
KEY SKILLS: ${mustHave || 'enterprise sales, SaaS, B2B'}
${salaryNote}

Search strategy — run ALL of these queries:
1. Search LinkedIn Jobs: site:linkedin.com/jobs "${roles.split(',')[0]?.trim()}" at each company
2. Search ATS boards: site:greenhouse.io OR site:lever.co OR site:ashbyhq.com for each company name
3. Search direct careers pages for each company

Return EVERY open position you find — no limit on count. I want as many as possible.

For each job output a JSON object with these exact keys:
- title: exact job title from the posting
- company: company name (must be from the list above)
- location: city/state or "Remote"
- url: the direct URL to the job posting (linkedin.com/jobs/view/..., boards.greenhouse.io/..., etc.)
- description: 1–2 sentence snippet from the posting
- salary: salary range string if shown, otherwise ""

Output ONLY a JSON array between JOBS_START and JOBS_END markers:

JOBS_START
[
  {
    "title": "Enterprise Account Executive",
    "company": "Acme Corp",
    "location": "Remote",
    "url": "https://www.linkedin.com/jobs/view/123456789/",
    "description": "Lead enterprise sales cycles for Fortune 500 accounts...",
    "salary": "$150,000 - $180,000"
  }
]
JOBS_END

Rules:
- Only include companies from the list above
- Only include roles matching the target roles
- Include LinkedIn URLs (linkedin.com/jobs/view/...) — these are valid and preferred
- Do NOT fabricate jobs — only include postings you can verify via live search
- Do NOT include expired or filled roles`;
  }

  // ── Standard broad search — ATS-first (what Perplexity can actually search) ─
  const role0 = roles.split(',')[0]?.trim() || 'Account Executive';
  const role1 = roles.split(',')[1]?.trim() || 'Account Manager';
  const skill0 = mustHave.split(',')[0]?.trim() || 'SaaS';
  const loc0   = locations.split(',')[0]?.trim() || 'Remote';

  return `You are a job search assistant with live Google Search access. Find currently open B2B sales roles by running these SPECIFIC Google searches right now:

SEARCH QUERY 1: site:boards.greenhouse.io "${role0}" ${workType === 'remote only' ? 'remote' : loc0}
SEARCH QUERY 2: site:jobs.lever.co "${role0}" ${workType === 'remote only' ? 'remote' : loc0}
SEARCH QUERY 3: site:jobs.ashbyhq.com "${role0}" ${workType === 'remote only' ? 'remote' : ''}
SEARCH QUERY 4: site:jobs.lever.co "${role1}" ${workType === 'remote only' ? 'remote' : loc0}
SEARCH QUERY 5: site:boards.greenhouse.io "${skill0} ${role0}"
SEARCH QUERY 6: site:jobs.ashbyhq.com "${role1}"
SEARCH QUERY 7: site:myworkdayjobs.com "${role0}" remote
SEARCH QUERY 8: site:linkedin.com/jobs/view "${role0}" "${skill0}"

TARGET ROLES (must match one): ${roles}
WORK TYPE: ${workType} | LOCATIONS: ${locations}
KEY SKILLS: ${mustHave || 'enterprise sales, SaaS, B2B'}
${industries ? `INDUSTRIES: ${industries}` : ''}
${salaryNote}

Run ALL 8 queries and collect every unique job posting URL you find. Aim for 20+ results.

For each job output a JSON object with these exact keys:
- title: exact job title from the posting
- company: company name
- location: city/state or "Remote"
- url: direct URL to the job posting (boards.greenhouse.io/..., jobs.lever.co/..., jobs.ashbyhq.com/..., linkedin.com/jobs/view/...)
- description: 1–2 sentence snippet from the posting
- salary: salary range string if shown, otherwise ""

Output ONLY a JSON array between JOBS_START and JOBS_END markers. No other text outside these markers:

JOBS_START
[
  {
    "title": "Enterprise Account Executive",
    "company": "Acme Corp",
    "location": "Remote",
    "url": "https://boards.greenhouse.io/acmecorp/jobs/1234567",
    "description": "Lead enterprise sales cycles for Fortune 500 accounts...",
    "salary": "$150,000 - $180,000"
  }
]
JOBS_END

Rules:
- Use DIRECT posting URLs only (not search result pages or company homepages)
- Do NOT fabricate jobs — only include postings you verified via live search
- Do NOT include expired or filled roles
- Include LinkedIn URLs only if they are job VIEW pages (linkedin.com/jobs/view/...) not search pages`;
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
  sourceLabel = 'Gemini',
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
      source:      sourceLabel,
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

// ── Greenhouse URL validator ───────────────────────────────────────────────────
// Gemini often returns Greenhouse URLs with hallucinated job IDs (e.g. /jobs/4000000).
// This validator hits the real public Greenhouse API for every GH URL:
//   - If the job ID is real → keep it (and update URL from the API's absolute_url).
//   - If the job ID is fake/missing → search the company's full job board by title.
//   - If no real match is found → drop the listing entirely.
// Results are cached per slug+id to avoid redundant network calls.

const _ghValidationCache = new Map<string, string | null>(); // key → real URL or null

async function resolveGreenhouseUrl(applyUrl: string, title: string): Promise<string | null> {
  const ghMatch = applyUrl.match(/greenhouse\.io\/([^/?#]+)\/jobs\/(\d+)/i);
  if (!ghMatch) return applyUrl; // not a GH job URL — pass through

  const [, slug, jobId] = ghMatch;
  const cacheKey = `${slug}::${jobId}`;
  if (_ghValidationCache.has(cacheKey)) return _ghValidationCache.get(cacheKey)!;

  // Step 1: verify the specific job ID exists
  const idUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs/${jobId}?content=false`;
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(idUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.ok) {
      const data = await res.json() as { absolute_url?: string; title?: string };
      const realUrl = data.absolute_url ?? applyUrl;
      console.log(`[GH-validate] ✓ Real job: ${slug}/jobs/${jobId} → "${data.title ?? 'unknown'}"`);
      _ghValidationCache.set(cacheKey, realUrl);
      return realUrl;
    }
    // 404 or other error — job ID is fake, fall through to title search
    console.log(`[GH-validate] ✗ Job ID ${jobId} not found for ${slug} — searching by title`);
  } catch {
    console.log(`[GH-validate] ✗ Timeout checking ${slug}/jobs/${jobId} — searching by title`);
  }

  // Step 2: search the company's full job board by title match
  const boardUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=false`;
  try {
    const ctrl2 = new AbortController();
    setTimeout(() => ctrl2.abort(), 10000);
    const res2 = await fetch(boardUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal: ctrl2.signal,
    });
    if (res2.ok) {
      const board = await res2.json() as { jobs?: Array<{ id: number; title: string; absolute_url: string }> };
      const jobs = board.jobs ?? [];
      if (jobs.length === 0) {
        console.log(`[GH-validate] ✗ ${slug} board returned 0 jobs — dropping listing`);
        _ghValidationCache.set(cacheKey, null);
        return null;
      }
      // Score matches: exact title > title words overlap
      const titleLow = title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
      const titleWords = new Set(titleLow.split(/\s+/).filter(w => w.length > 2));
      let bestMatch: { id: number; title: string; absolute_url: string } | null = null;
      let bestScore = 0;
      for (const j of jobs) {
        const jLow = j.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
        if (jLow === titleLow) { bestMatch = j; bestScore = 999; break; }
        const overlap = jLow.split(/\s+/).filter(w => w.length > 2 && titleWords.has(w)).length;
        if (overlap > bestScore) { bestScore = overlap; bestMatch = j; }
      }
      if (bestMatch && bestScore >= 2) {
        console.log(`[GH-validate] ✓ Found by title match (score=${bestScore}): "${bestMatch.title}" → ${bestMatch.absolute_url}`);
        _ghValidationCache.set(`${slug}::${bestMatch.id}`, bestMatch.absolute_url);
        _ghValidationCache.set(cacheKey, bestMatch.absolute_url);
        return bestMatch.absolute_url;
      }
      console.log(`[GH-validate] ✗ No title match (score=${bestScore}) for "${title}" in ${slug} (${jobs.length} jobs on board) — dropping`);
    } else {
      console.log(`[GH-validate] ✗ ${slug} board unreachable (${res2.status}) — dropping listing`);
    }
  } catch {
    console.log(`[GH-validate] ✗ Timeout fetching board for ${slug} — dropping listing`);
  }

  _ghValidationCache.set(cacheKey, null);
  return null;
}

/**
 * Validate and fix Greenhouse URLs in a list of Gemini jobs.
 * Jobs with unresolvable Greenhouse URLs are dropped.
 * Non-Greenhouse jobs are passed through unchanged.
 */
async function validateGreenhouseUrls(jobs: GeminiJob[]): Promise<GeminiJob[]> {
  const ghJobs    = jobs.filter(j => /greenhouse\.io\/[^/?#]+\/jobs\/\d+/i.test(j.applyUrl));
  const nonGhJobs = jobs.filter(j => !/greenhouse\.io\/[^/?#]+\/jobs\/\d+/i.test(j.applyUrl));

  if (ghJobs.length === 0) return jobs;

  console.log(`[GH-validate] Validating ${ghJobs.length} Greenhouse URL(s) from Gemini…`);

  // Run in parallel (max 5 concurrent to be gentle on the API)
  const CHUNK = 5;
  const resolved: GeminiJob[] = [];
  for (let i = 0; i < ghJobs.length; i += CHUNK) {
    const chunk = ghJobs.slice(i, i + CHUNK);
    const results = await Promise.all(
      chunk.map(async (job) => {
        const realUrl = await resolveGreenhouseUrl(job.applyUrl, job.title);
        if (!realUrl) return null;
        return realUrl === job.applyUrl ? job : { ...job, applyUrl: realUrl };
      })
    );
    for (const r of results) { if (r) resolved.push(r); }
  }

  const dropped = ghJobs.length - resolved.length;
  if (dropped > 0) console.log(`[GH-validate] Dropped ${dropped} Greenhouse listing(s) with unresolvable/fake job IDs`);
  console.log(`[GH-validate] ${resolved.length}/${ghJobs.length} Greenhouse URL(s) validated`);

  return [...nonGhJobs, ...resolved];
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
