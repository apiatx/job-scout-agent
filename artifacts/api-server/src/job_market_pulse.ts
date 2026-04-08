/**
 * Job Market Pulse
 *
 * Combines two data sources:
 *   1. Scout-collected jobs DB — raw hiring activity per company/role/salary
 *   2. Claude + web search — real-time signal assessment per company
 *
 * For each company the scout has found jobs at, Claude assesses:
 *   - Is this TRUE GROWTH (new funding, new product, new market)?
 *   - Or HYPE / FLUFF / DESPERATION (patching bad product with headcount)?
 *   - Or AI RISK (core offering soon automated away)?
 *
 * Model: claude-haiku-4-5 with web_search tool
 */

import { aiRouter } from './ai_router.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PulseSignal = 'true_growth' | 'cautious' | 'hype_risk' | 'ai_risk' | 'desperate_hiring' | 'unknown';

export interface ScoutCompanyStat {
  company_name: string;
  job_count: number;
  roles: string[];
  avg_salary: number | null;
  max_salary: number | null;
  newest_posting: string; // ISO date
  locations: string[];
}

export interface PulseCompanyCard {
  company_name: string;
  company_url: string | null;
  signal: PulseSignal;
  signal_label: string;
  signal_rationale: string;
  agent_analysis: string;
  growth_evidence: string[];
  risk_flags: string[];
  ai_vulnerability: string | null;
  hiring_driver: string;
  recommendation: 'pursue' | 'watch' | 'caution' | 'avoid';
  scout_job_count: number;
  scout_roles: string[];
  scout_avg_salary: number | null;
  source_citations: { title: string; url: string }[];
}

export interface MarketPulseStats {
  top_roles: { role: string; count: number }[];
  avg_salary_by_sector: { sector: string; avg: number }[];
  total_companies_tracked: number;
  total_jobs_30d: number;
  salary_floor_hit_pct: number;
}

export interface JobMarketPulseResult {
  generated_at: string;
  pulse_headline: string;
  market_mood: 'hot' | 'warm' | 'cooling' | 'mixed';
  market_commentary: string;
  stats: MarketPulseStats;
  companies: PulseCompanyCard[];
  model_used: string | null;
  grounding_sources_count: number;
}

// ── Prompt ────────────────────────────────────────────────────────────────────

function buildPulsePrompt(companies: ScoutCompanyStat[], criteria: { target_roles: string[]; industries: string[]; min_salary: number | null }): string {
  const today = new Date().toISOString().split('T')[0];
  const companyList = companies.slice(0, 18).map(c =>
    `- ${c.company_name} (${c.job_count} jobs found, roles: ${c.roles.slice(0, 4).join(', ')}, avg salary: ${c.avg_salary ? '$' + Math.round(c.avg_salary / 1000) + 'K' : 'unknown'})`
  ).join('\n');

  return `You are a sharp senior market intelligence analyst specializing in B2B SaaS, enterprise tech, and the tech job market.
Today's date: ${today}

A job scout has found active job postings at the following companies over the past 30 days. Your job is to assess whether each company's hiring activity represents GENUINE OPPORTUNITY or HYPE/RISK/DESPERATION.

TARGET ROLE CONTEXT: ${criteria.target_roles.slice(0, 5).join(', ')}
INDUSTRIES: ${criteria.industries.slice(0, 5).join(', ')}
${criteria.min_salary ? `SALARY FLOOR: $${criteria.min_salary.toLocaleString()}+` : ''}

COMPANIES WITH ACTIVE JOB POSTINGS (scout-collected data):
${companyList}

Use web search to research each company and classify its hiring signal. Apply a critical, skeptical lens:

TRUE GROWTH signals:
- New funding round (Series B+), recent IPO, profitable growth
- New product line, new market/geo expansion, new enterprise contract wins
- CRO or VP Sales hire after strong revenue quarter (adding headcount to capitalize)
- New partnership that unlocks new customer segments
- Competitor weakness creating market share opportunity

HYPE / FLUFF / DESPERATION signals:
- Lots of SDR/BDR hiring at a company with known pipeline problems or poor product-market fit
- Hiring surge while burning cash and missing targets (trying to solve a product problem with headcount)
- Post-IPO hiring to justify valuation, not real demand
- High employee churn, Glassdoor red flags, recent layoffs + rehire cycle
- Endless "new AI features" announcements covering a stagnating core product

AI RISK signals:
- Core product is being commoditized by foundation models (e.g. basic chatbot, simple automation, workflow tools now built into GPT/Claude)
- Category is being absorbed by bigger platforms (e.g. "AI writing" eaten by Microsoft Copilot)
- Company pivoting desperately to "AI" branding without clear product differentiation

DESPERATE HIRING signals:
- Multiple quarters of missed revenue targets, CRO turnover
- Aggressive hiring to hit headcount optics before a funding round
- Hiring 5x more AEs while not investing in SE/CS (pipeline first, close last — backwards)

For each company, provide a brutally honest but fair assessment. Then also write a brief, direct "agent analysis" paragraph (3-4 sentences) that tells the job seeker whether to pursue, watch, or avoid — and why.

Return EXACTLY this JSON between PULSE_START and PULSE_END:

PULSE_START
{
  "generated_at": "${new Date().toISOString()}",
  "pulse_headline": "One sharp sentence summarizing the overall job market mood right now for this person",
  "market_mood": "hot",
  "market_commentary": "2-3 sentences on what's driving hiring right now in this person's target sectors. Be specific about current conditions.",
  "companies": [
    {
      "company_name": "Exact Company Name",
      "company_url": "https://company.com or null",
      "signal": "true_growth",
      "signal_label": "True Growth",
      "signal_rationale": "One sentence explaining why — be specific with a recent, verifiable fact",
      "agent_analysis": "3-4 sentence direct analysis for the job seeker. Is this a great opportunity? Red flags? What to watch for? Speak candidly.",
      "growth_evidence": ["Specific evidence item 1", "Evidence item 2"],
      "risk_flags": ["Any concerns, if none leave empty array"],
      "ai_vulnerability": "Specific AI threat to this company's core business, or null if not applicable",
      "hiring_driver": "What specifically is driving this hiring wave",
      "recommendation": "pursue",
      "source_citations": [
        { "title": "Article title", "url": "https://source.url" }
      ]
    }
  ]
}
PULSE_END

Rules:
- signal must be exactly one of: true_growth | cautious | hype_risk | ai_risk | desperate_hiring | unknown
- market_mood must be exactly one of: hot | warm | cooling | mixed
- recommendation must be exactly one of: pursue | watch | caution | avoid
- Cover as many of the listed companies as you can (aim for all of them if time permits, at minimum the top 10)
- Be brutally honest — job seekers need to know if a company is a fluf play or a real opportunity
- The agent_analysis must be the most valuable part of each card: specific, opinionated, actionable
- Each company must have at least one source_citation`;
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

// ── Parser ────────────────────────────────────────────────────────────────────

function parsePulseFromText(text: string): Partial<JobMarketPulseResult> | null {
  // Strategy 1: PULSE_START / PULSE_END markers (PULSE_END may be absent if truncated)
  const markerStart = text.indexOf('PULSE_START');
  if (markerStart !== -1) {
    const markerEnd = text.indexOf('PULSE_END');
    const rawJson = markerEnd !== -1
      ? text.slice(markerStart + 'PULSE_START'.length, markerEnd).trim()
      : text.slice(markerStart + 'PULSE_START'.length).trim();
    for (const attempt of [rawJson, repairTruncatedJson(rawJson)]) {
      try {
        const p = JSON.parse(attempt);
        if (p?.companies) {
          if (attempt !== rawJson) console.log(`[JobMarketPulse] Repaired truncated JSON — ${p.companies.length} companies`);
          return p;
        }
      } catch { /* continue */ }
    }
  }

  // Strategy 2: largest JSON blob with 'companies' key, with repair fallback
  const jsonStart = text.indexOf('{');
  if (jsonStart !== -1) {
    const candidate = text.slice(jsonStart);
    if (candidate.includes('"companies"')) {
      for (const attempt of [candidate, repairTruncatedJson(candidate)]) {
        try {
          const p = JSON.parse(attempt);
          if (p?.companies?.length > 0) {
            if (attempt !== candidate) console.log(`[JobMarketPulse] Repaired truncated JSON — ${p.companies.length} companies`);
            return p;
          }
        } catch { /* continue */ }
      }
    }
  }

  console.log('[JobMarketPulse] Could not parse JSON. Preview:', text.slice(0, 400));
  return null;
}

// ── Signal normaliser ─────────────────────────────────────────────────────────

const VALID_SIGNALS: PulseSignal[] = ['true_growth','cautious','hype_risk','ai_risk','desperate_hiring','unknown'];
const VALID_RECS = ['pursue','watch','caution','avoid'] as const;

function normaliseCard(raw: Partial<PulseCompanyCard>, stat: ScoutCompanyStat | undefined): PulseCompanyCard {
  const signal: PulseSignal = VALID_SIGNALS.includes(raw.signal as PulseSignal) ? raw.signal as PulseSignal : 'unknown';
  const rec = VALID_RECS.includes(raw.recommendation as typeof VALID_RECS[number]) ? raw.recommendation! : 'watch';
  return {
    company_name:     raw.company_name || stat?.company_name || 'Unknown',
    company_url:      raw.company_url ?? null,
    signal,
    signal_label:     raw.signal_label || signalDefaultLabel(signal),
    signal_rationale: raw.signal_rationale || '',
    agent_analysis:   raw.agent_analysis || '',
    growth_evidence:  Array.isArray(raw.growth_evidence) ? raw.growth_evidence : [],
    risk_flags:       Array.isArray(raw.risk_flags) ? raw.risk_flags : [],
    ai_vulnerability: raw.ai_vulnerability ?? null,
    hiring_driver:    raw.hiring_driver || '',
    recommendation:   rec,
    scout_job_count:  stat?.job_count ?? 0,
    scout_roles:      stat?.roles ?? [],
    scout_avg_salary: stat?.avg_salary ?? null,
    source_citations: Array.isArray(raw.source_citations) ? raw.source_citations : [],
  };
}

function signalDefaultLabel(s: PulseSignal): string {
  const m: Record<PulseSignal, string> = {
    true_growth:      'True Growth',
    cautious:         'Cautious',
    hype_risk:        'Hype Risk',
    ai_risk:          'AI Risk',
    desperate_hiring: 'Desperate Hiring',
    unknown:          'Unverified',
  };
  return m[s];
}

// ── Main export ───────────────────────────────────────────────────────────────

const CLAUDE_MODEL = 'claude-haiku-4-5';

export async function generateJobMarketPulse(
  scoutStats: ScoutCompanyStat[],
  criteria: { target_roles: string[]; industries: string[]; min_salary: number | null },
): Promise<JobMarketPulseResult> {



  const client = aiRouter;
  const prompt = buildPulsePrompt(scoutStats, criteria);
  const statMap = new Map(scoutStats.map(s => [s.company_name.toLowerCase(), s]));

  console.log(`\n──── JOB MARKET PULSE GENERATION ─────────────────────────────`);
  console.log(`[JobMarketPulse] ${scoutStats.length} companies to assess | model: ${CLAUDE_MODEL}`);

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

  console.log(`[JobMarketPulse] ✓ ${CLAUDE_MODEL} — ${groundingSources} web search calls`);

  const parsed = parsePulseFromText(text);
  if (!parsed) throw new Error('Could not parse structured output');

  // Merge scout stats into each card
  const cards: PulseCompanyCard[] = (parsed.companies ?? []).map((raw: Partial<PulseCompanyCard>) => {
    const stat = statMap.get((raw.company_name || '').toLowerCase());
    return normaliseCard(raw, stat);
  });

  // Sort: pursue first, then by signal quality, then by scout job count
  const sigOrder: Record<PulseSignal, number> = { true_growth:5, cautious:4, unknown:3, hype_risk:2, desperate_hiring:1, ai_risk:0 };
  const recOrder: Record<string, number> = { pursue:4, watch:3, caution:2, avoid:1 };
  cards.sort((a, b) => {
    const ro = (recOrder[b.recommendation] ?? 0) - (recOrder[a.recommendation] ?? 0);
    if (ro !== 0) return ro;
    return (sigOrder[b.signal] ?? 0) - (sigOrder[a.signal] ?? 0);
  });

  console.log(`[JobMarketPulse] ${cards.length} company cards | mood: ${parsed.market_mood}`);
  console.log(`──────────────────────────────────────────────────────────────`);

  return {
    generated_at: new Date().toISOString(),
    pulse_headline: parsed.pulse_headline ?? '',
    market_mood: (['hot','warm','cooling','mixed'].includes(parsed.market_mood as string) ? parsed.market_mood : 'mixed') as JobMarketPulseResult['market_mood'],
    market_commentary: parsed.market_commentary ?? '',
    stats: buildStats(scoutStats, criteria),
    companies: cards,
    model_used: CLAUDE_MODEL,
    grounding_sources_count: groundingSources,
  };
}

// ── Stats builder (from raw DB data, no AI needed) ────────────────────────────

export function buildStats(stats: ScoutCompanyStat[], criteria: { target_roles: string[] }): MarketPulseStats {
  const roleCount: Record<string, number> = {};
  let totalJobs = 0;
  let salarySum = 0, salaryCnt = 0;
  let salaryHits = 0;

  for (const s of stats) {
    totalJobs += s.job_count;
    for (const r of s.roles) {
      const key = r.trim();
      roleCount[key] = (roleCount[key] || 0) + 1;
    }
    if (s.avg_salary) { salarySum += s.avg_salary; salaryCnt++; }
  }

  const top_roles = Object.entries(roleCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([role, count]) => ({ role, count }));

  void salarySum; void salaryCnt; void salaryHits; void criteria;

  return {
    top_roles,
    avg_salary_by_sector: [],
    total_companies_tracked: stats.length,
    total_jobs_30d: totalJobs,
    salary_floor_hit_pct: 0,
  };
}
