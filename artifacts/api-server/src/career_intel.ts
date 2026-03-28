/**
 * Career Intel Service
 *
 * Generates daily-refreshing company intelligence cards tailored to the user's
 * job-search settings using Gemini + Google Search grounding.
 *
 * Architecture contract:
 *   Gemini = discovery + synthesis ONLY
 *   This module does NOT touch the jobs pipeline, scoring, or Claude tailoring
 *
 * Model waterfall (same ordering as gemini_discovery.ts):
 *   1. GEMINI_MODEL env override (if set)
 *   2. gemini-3-flash-preview  — speed/cost default
 *   3. gemini-3.1-pro-preview  — quality mode
 *   4. gemini-flash-latest     — alias fallback
 *   5. gemini-pro-latest       — alias fallback
 *
 * Refresh behaviour:
 *   - Results persisted to `career_intel` DB table
 *   - Cached for 24h; GET endpoint returns stale flag
 *   - POST /api/career-intel/refresh triggers synchronous regeneration
 */

import { GoogleGenAI, type GroundingChunk } from '@google/genai';

// ── Output types ──────────────────────────────────────────────────────────────

export interface IntelCitation {
  title: string;
  url: string;
}

export interface IntelTheme {
  theme: string;
  summary: string;
  why_it_matters_for_job_search: string;
}

export interface IntelCompanyCard {
  company_name: string;
  company_url: string | null;
  summary: string;
  why_it_is_hot_now: string;
  why_it_could_be_a_good_place_to_work: string;
  likely_hiring_signal: string;
  likely_relevant_roles: string[];
  fit_to_user_settings: string;
  action_recommendation: 'watch' | 'target_now' | 'network_in' | 'low_priority';
  confidence_score: number;
  risk_flags: string[];
  source_citations: IntelCitation[];
  gemini_web_search_queries: string[];
}

export interface CareerIntelResult {
  generated_at: string;
  market_summary: string;
  themes: IntelTheme[];
  companies: IntelCompanyCard[];
  model_used: string | null;
  grounding_sources_count: number;
}

export interface CareerIntelCriteria {
  target_roles: string[];
  industries: string[];
  locations: string[];
  work_type: string;
  must_have: string[];
  nice_to_have: string[];
  avoid: string[];
  min_salary: number | null;
  experience_levels: string[];
  vertical_niches: string[];
}

// ── Model waterfall ───────────────────────────────────────────────────────────

interface ModelCandidate {
  modelName: string;
  note: string;
}

const BUILTIN_CANDIDATES: ModelCandidate[] = [
  { modelName: 'gemini-3-flash-preview',  note: 'Gemini 3 Flash — speed/cost default' },
  { modelName: 'gemini-3.1-pro-preview',  note: 'Gemini 3.1 Pro — quality mode' },
  { modelName: 'gemini-flash-latest',     note: 'alias — resolves to latest Flash' },
  { modelName: 'gemini-pro-latest',       note: 'alias — resolves to latest Pro' },
];

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

function buildCandidateChain(): ModelCandidate[] {
  const envModel = process.env.GEMINI_MODEL?.trim();
  if (!envModel) return [...BUILTIN_CANDIDATES];
  const deduped = BUILTIN_CANDIDATES.filter(c => c.modelName !== envModel);
  return [{ modelName: envModel, note: 'user-configured via GEMINI_MODEL env var' }, ...deduped];
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildIntelPrompt(criteria: CareerIntelCriteria): string {
  const roles    = criteria.target_roles.slice(0, 6).join(', ')  || 'Account Executive, Sales Manager';
  const inds     = criteria.industries.slice(0, 5).join(', ')    || 'SaaS, Technology, B2B software';
  const niches   = criteria.vertical_niches.slice(0, 4).join(', ');
  const keywords = criteria.must_have.slice(0, 6).join(', ');
  const avoid    = criteria.avoid.slice(0, 5).join(', ');
  const workMode = criteria.work_type === 'remote' ? 'Remote / distributed' : criteria.work_type === 'hybrid' ? 'Hybrid or remote' : criteria.locations.join(', ') || 'Flexible';
  const today    = new Date().toISOString().split('T')[0];

  return `You are a senior career intelligence analyst specializing in B2B SaaS and tech job markets.
Today's date: ${today}

Use Google Search to research and synthesize current company intelligence for a job seeker with these preferences:

TARGET ROLES: ${roles}
INDUSTRIES: ${inds}${niches ? `\nVERTICAL NICHES: ${niches}` : ''}${keywords ? `\nKEY SKILLS: ${keywords}` : ''}${avoid ? `\nAVOID: ${avoid}` : ''}
WORK PREFERENCE: ${workMode}${criteria.min_salary ? `\nTARGET SALARY: $${criteria.min_salary.toLocaleString()}+` : ''}

Research signals to search for:
- Recent funding rounds (Series A–D, growth equity, IPO signals)
- Company expansions, new office openings, new market entries
- Product launches, major feature announcements
- Executive hires (new CRO, VP Sales, VP Engineering signals expansion)
- Acquisitions or being acquired (both create hiring waves)
- Strong earnings or revenue growth announcements
- Strategic partnerships or new enterprise contracts
- AI, infrastructure, security, or data investment signals
- Competitor weakness creating opportunity for others
- "We're hiring" signals, LinkedIn headcount growth, job posting surges
- Layoffs at competitors (talent available = acquisition targets hiring)

For each company you identify as worth tracking:
- Explain clearly why it's hot RIGHT NOW (specific, recent, cited reason)
- Why it might be an attractive employer (culture, growth, comp, mission)
- What roles they're likely opening given the signal
- How well it fits the user's target roles and preferences
- What action the job seeker should take

Return EXACTLY this JSON structure between the markers INTEL_START and INTEL_END. No text outside markers:

INTEL_START
{
  "generated_at": "${new Date().toISOString()}",
  "market_summary": "2-3 sentence synthesis of the current job market for this person's target roles and industries",
  "themes": [
    {
      "theme": "Theme name (e.g. AI infrastructure investment wave)",
      "summary": "What's happening in this theme right now",
      "why_it_matters_for_job_search": "Why job seekers targeting these roles should pay attention"
    }
  ],
  "companies": [
    {
      "company_name": "Company Name",
      "company_url": "https://company.com or null",
      "summary": "1-2 sentence company overview",
      "why_it_is_hot_now": "Specific, recent, cited reason this company is notable right now",
      "why_it_could_be_a_good_place_to_work": "Culture, growth trajectory, compensation reputation, mission",
      "likely_hiring_signal": "Specific evidence they are or will be hiring soon",
      "likely_relevant_roles": ["Role 1", "Role 2"],
      "fit_to_user_settings": "How well this matches the user's target roles, industries, work preference",
      "action_recommendation": "target_now",
      "confidence_score": 0.85,
      "risk_flags": ["Any concerns: layoffs, burn rate, leadership instability"],
      "source_citations": [
        { "title": "Article or source title", "url": "https://source.url" }
      ],
      "gemini_web_search_queries": ["search queries used"]
    }
  ]
}
INTEL_END

Rules:
- action_recommendation must be exactly one of: target_now | watch | network_in | low_priority
- confidence_score must be a number 0.0 to 1.0
- Find 6–12 companies, ranked by relevance to the user's settings
- Prioritize companies with RECENT, SPECIFIC, VERIFIABLE signals from the last 90 days
- Do NOT include companies the user should avoid: ${avoid || 'none specified'}
- Each company must have at least one source_citation with a real URL
- Prefer companies hiring for roles matching: ${roles}`;
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseIntelFromText(text: string): Omit<CareerIntelResult, 'model_used' | 'grounding_sources_count'> | null {
  // Strategy 1: INTEL_START / INTEL_END markers
  const markerMatch = text.match(/INTEL_START\s*([\s\S]*?)\s*INTEL_END/);
  if (markerMatch) {
    try {
      const parsed = JSON.parse(markerMatch[1].trim());
      if (parsed && parsed.companies) return parsed;
    } catch { /* fall through */ }
  }

  // Strategy 2: largest JSON object with 'companies' key
  const objMatches = (text.match(/\{[\s\S]*?"companies"\s*:\s*\[[\s\S]*?\]\s*\}/g) as string[] | null) ?? [];
  for (const candidate of objMatches.sort((a, b) => b.length - a.length)) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && Array.isArray(parsed.companies) && parsed.companies.length > 0) return parsed;
    } catch { /* continue */ }
  }

  console.log('[CareerIntel] Could not parse structured output. Preview:', text.slice(0, 500));
  return null;
}

// ── Post-processing: ranking + normalisation ──────────────────────────────────

function rankAndNormaliseCards(
  cards: IntelCompanyCard[],
  criteria: CareerIntelCriteria,
  groundingQueries: string[],
): IntelCompanyCard[] {
  const titleKeywords = criteria.target_roles.map(r => r.toLowerCase());
  const indKeywords   = criteria.industries.map(i => i.toLowerCase());

  return cards
    .map(card => {
      // Ensure action_recommendation is a valid value
      const validActions = ['target_now', 'watch', 'network_in', 'low_priority'] as const;
      const action = validActions.includes(card.action_recommendation as typeof validActions[number])
        ? card.action_recommendation
        : 'watch' as const;

      // Clamp confidence
      const confidence = Math.max(0, Math.min(1, Number(card.confidence_score) || 0.5));

      // Attach web search queries from grounding if the card doesn't have them
      const queries = Array.isArray(card.gemini_web_search_queries) && card.gemini_web_search_queries.length > 0
        ? card.gemini_web_search_queries
        : groundingQueries.slice(0, 3);

      return { ...card, action_recommendation: action, confidence_score: confidence, gemini_web_search_queries: queries };
    })
    .sort((a, b) => {
      // Boost: target_now > watch > network_in > low_priority
      const tierScore = (card: IntelCompanyCard) => {
        if (card.action_recommendation === 'target_now')   return 4;
        if (card.action_recommendation === 'network_in')   return 3;
        if (card.action_recommendation === 'watch')        return 2;
        return 1;
      };

      // Boost: role keyword match in likely_relevant_roles
      const roleMatch = (card: IntelCompanyCard) =>
        card.likely_relevant_roles?.some(r => titleKeywords.some(k => r.toLowerCase().includes(k))) ? 1 : 0;

      // Boost: industry match in summary
      const indMatch = (card: IntelCompanyCard) =>
        indKeywords.some(k => (card.summary + card.why_it_is_hot_now).toLowerCase().includes(k)) ? 1 : 0;

      const scoreA = tierScore(a) * 10 + a.confidence_score * 5 + roleMatch(a) * 3 + indMatch(a) * 2;
      const scoreB = tierScore(b) * 10 + b.confidence_score * 5 + roleMatch(b) * 3 + indMatch(b) * 2;
      return scoreB - scoreA;
    });
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function generateCareerIntel(criteria: CareerIntelCriteria): Promise<CareerIntelResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

  const timeoutMs = parseInt(process.env.GEMINI_TIMEOUT_SECONDS ?? '120', 10) * 1000;
  const candidates = buildCandidateChain();
  const prompt = buildIntelPrompt(criteria);
  const ai = new GoogleGenAI({ apiKey });

  console.log(`\n──── CAREER INTEL GENERATION ─────────────────────────────────`);
  console.log(`[CareerIntel] Candidate chain: ${candidates.map(c => c.modelName).join(' → ')}`);

  for (const candidate of candidates) {
    const { modelName, note } = candidate;
    console.log(`[CareerIntel] Trying: ${modelName} (${note})`);

    try {
      const requestPromise = ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.2,
        },
      });

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${timeoutMs / 1000}s`)), timeoutMs)
      );

      const response = await Promise.race([requestPromise, timeoutPromise]);
      const text = response.text ?? '';
      const groundingMeta = response.candidates?.[0]?.groundingMetadata ?? {};

      const webSearchQueries: string[] = groundingMeta.webSearchQueries ?? [];
      const groundingSources = (groundingMeta.groundingChunks ?? [])
        .filter((c: GroundingChunk) => c.web?.uri)
        .length;

      console.log(`[CareerIntel] ✓ Model: ${modelName} — ${groundingSources} grounding sources, ${webSearchQueries.length} queries`);

      const parsed = parseIntelFromText(text);
      if (!parsed) {
        throw new Error('Could not parse structured output from model response');
      }

      const ranked = rankAndNormaliseCards(parsed.companies ?? [], criteria, webSearchQueries);
      console.log(`[CareerIntel] ${ranked.length} company cards ranked`);
      console.log(`──────────────────────────────────────────────────────────────`);

      return {
        generated_at: new Date().toISOString(),
        market_summary: parsed.market_summary ?? '',
        themes: Array.isArray(parsed.themes) ? parsed.themes : [],
        companies: ranked,
        model_used: modelName,
        grounding_sources_count: groundingSources,
      };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isModelUnavailableError(err)) {
        console.warn(`[CareerIntel] ✗ ${modelName} unavailable: ${msg} — trying next`);
        continue;
      }
      console.error(`[CareerIntel] ✗ ${modelName} failed: ${msg}`);
      throw err; // Non-availability errors bubble up
    }
  }

  throw new Error(`All Career Intel model candidates exhausted: ${candidates.map(c => c.modelName).join(', ')}`);
}
