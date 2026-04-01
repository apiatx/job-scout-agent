/**
 * Career Intel Service
 *
 * Generates daily-refreshing company intelligence cards tailored to the user's
 * job-search settings using Claude + web search.
 *
 * Architecture contract:
 *   Claude = discovery + synthesis ONLY
 *   This module does NOT touch the jobs pipeline, scoring, or Claude tailoring
 *
 * Model: claude-sonnet-4-6 with web_search tool
 *
 * Refresh behaviour:
 *   - Results persisted to `career_intel` DB table
 *   - Cached for 24h; GET endpoint returns stale flag
 *   - POST /api/career-intel/refresh triggers synchronous regeneration
 */

import Anthropic from '@anthropic-ai/sdk';

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

Use web search to research and synthesize current company intelligence for a job seeker with these preferences:

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

// ── JSON repair helper ────────────────────────────────────────────────────────

function repairTruncatedJson(raw: string): string {
  let depth = 0, arrDepth = 0, lastGoodClose = -1;
  let inStr = false, esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (esc)            { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"')      { inStr = !inStr; continue; }
    if (inStr)          continue;
    if (c === '[')      arrDepth++;
    if (c === ']')      arrDepth = Math.max(0, arrDepth - 1);
    if (c === '{')      depth++;
    if (c === '}') { depth--; if (depth === 0 && arrDepth > 0) lastGoodClose = i; }
  }
  const base = lastGoodClose !== -1 ? raw.slice(0, lastGoodClose + 1) : raw;
  const stack: string[] = [];
  const closer: Record<string, string> = { '[': ']', '{': '}' };
  inStr = false; esc = false;
  for (const c of base) {
    if (esc)             { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"')       { inStr = !inStr; continue; }
    if (inStr)           continue;
    if (c === '[' || c === '{') stack.push(c);
    if ((c === ']' || c === '}') && stack.length > 0) stack.pop();
  }
  return base + [...stack].reverse().map(o => closer[o]).join('');
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseIntelFromText(text: string): Omit<CareerIntelResult, 'model_used' | 'grounding_sources_count'> | null {
  // Strategy 1: INTEL_START / INTEL_END markers
  const markerMatch = text.match(/INTEL_START\s*([\s\S]*?)\s*INTEL_END/);
  if (markerMatch) {
    try {
      const parsed = JSON.parse(markerMatch[1].trim());
      if (parsed && parsed.companies) return parsed;
    } catch {
      // Marker content may be truncated — try repair
      try {
        const parsed = JSON.parse(repairTruncatedJson(markerMatch[1].trim()));
        if (parsed && Array.isArray(parsed.companies) && parsed.companies.length > 0) {
          console.log(`[CareerIntel] Repaired truncated marker JSON — ${parsed.companies.length} companies`);
          return parsed;
        }
      } catch { /* fall through */ }
    }
  }

  // Strategy 2: Find JSON starting at first '{' with 'companies' key, try repair if needed
  const jsonStart = text.indexOf('{');
  if (jsonStart !== -1) {
    const candidate = text.slice(jsonStart);
    if (candidate.includes('"companies"')) {
      for (const attempt of [candidate, repairTruncatedJson(candidate)]) {
        try {
          const parsed = JSON.parse(attempt);
          if (parsed && Array.isArray(parsed.companies) && parsed.companies.length > 0) {
            if (attempt !== candidate) console.log(`[CareerIntel] Repaired truncated JSON — ${parsed.companies.length} companies`);
            return parsed;
          }
        } catch { /* continue */ }
      }
    }
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

const CLAUDE_MODEL = 'claude-sonnet-4-6';

export async function generateCareerIntel(criteria: CareerIntelCriteria): Promise<CareerIntelResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');

  const client = new Anthropic({ apiKey });
  const prompt = buildIntelPrompt(criteria);

  console.log(`\n──── CAREER INTEL GENERATION ─────────────────────────────────`);
  console.log(`[CareerIntel] Model: ${CLAUDE_MODEL} with web search`);

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any[],
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

  const groundingSources = response.content.filter((b: any) => b.type === 'tool_use').length;

  console.log(`[CareerIntel] ✓ ${CLAUDE_MODEL} — ${groundingSources} web search calls, ${text.length} chars`);

  const parsed = parseIntelFromText(text);
  if (!parsed) {
    throw new Error('Could not parse structured output from model response');
  }

  const ranked = rankAndNormaliseCards(parsed.companies ?? [], criteria, []);
  console.log(`[CareerIntel] ${ranked.length} company cards ranked`);
  console.log(`──────────────────────────────────────────────────────────────`);

  return {
    generated_at: new Date().toISOString(),
    market_summary: parsed.market_summary ?? '',
    themes: Array.isArray(parsed.themes) ? parsed.themes : [],
    companies: ranked,
    model_used: CLAUDE_MODEL,
    grounding_sources_count: groundingSources,
  };
}
