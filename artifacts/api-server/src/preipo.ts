/**
 * Pre-IPO Intelligence Engine
 *
 * Uses Claude + web search to identify top Series A/B/C/D companies
 * experiencing hypergrowth — ranked by opportunity for sales professionals right now.
 *
 * Series B is the primary target: proven PMF, scaling sales motion, high OTE potential,
 * equity still meaningful before an IPO or acquisition event.
 *
 * Model: claude-sonnet-4-6 with web_search tool
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PreIpoCompany {
  company_name: string;
  company_url: string | null;
  funding_stage: 'Series A' | 'Series B' | 'Series C' | 'Series D+' | 'Unknown';
  vertical: string;
  founded_year: number | null;
  total_raised: string | null;
  last_round_size: string | null;
  last_round_date: string | null;
  lead_investors: string[];
  why_explosive_now: string;
  hypergrowth_signals: string[];
  sales_opportunity: string;
  likely_roles: string[];
  estimated_ote_range: string | null;
  equity_upside: string;
  ipo_timeline_guess: string | null;
  risk_flags: string[];
  momentum_score: number;
  action: 'apply_now' | 'watch_closely' | 'network_in' | 'monitor';
  source_citations: Array<{ title: string; url: string }>;
}

export interface PreIpoResult {
  generated_at: string;
  market_context: string;
  series_b_thesis: string;
  companies: PreIpoCompany[];
  model_used: string | null;
  grounding_sources_count: number;
}

export interface PreIpoCriteria {
  target_roles: string[];
  industries: string[];
  locations: string[];
  must_have: string[];
  vertical_niches: string[];
  min_salary: number | null;
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildPreIpoPrompt(criteria: PreIpoCriteria): string {
  const roles   = criteria.target_roles.slice(0, 6).join(', ')  || 'Account Executive, Sales Manager, Enterprise AE';
  const inds    = criteria.industries.slice(0, 5).join(', ')    || 'SaaS, AI, Cybersecurity, Fintech, Data Infrastructure';
  const niches  = criteria.vertical_niches.slice(0, 4).join(', ');
  const today   = new Date().toISOString().split('T')[0];

  return `You are a top-tier venture capital analyst and career intelligence researcher.
Today's date: ${today}

Your job: use web search to identify the most explosive, high-growth private companies at Series A, B, C, and D stages that a senior sales professional should be targeting RIGHT NOW.

The candidate is a sales professional targeting these roles: ${roles}
Their target industries/verticals: ${inds}${niches ? `\nVertical niches of interest: ${niches}` : ''}${criteria.min_salary ? `\nOTE target: $${criteria.min_salary.toLocaleString()}+` : ''}

SEARCH FOCUS — find companies with these real signals:
- Recent funding rounds announced in the last 12 months (Series A, B, C, D)
- Revenue or ARR milestones publicly announced ($10M ARR, $100M ARR, 3x YoY growth)
- Hypergrowth headcount expansion (LinkedIn growth >50% YoY, job posting surges)
- New CRO, VP Sales, or Head of Enterprise hired (= building the sales machine)
- Product-led growth transitioning to enterprise sales (= need salespeople NOW)
- Strategic partnerships with major platforms (AWS, Salesforce, Microsoft, Google)
- Named to recognized growth lists (Forbes Cloud 100, Deloitte Fast 500, Inc 5000)
- IPO rumors, S-1 filings, or "exploring strategic options" in the news
- Competitive displacement of legacy players in a large market
- AI-native companies in categories disrupting multi-billion dollar markets

SERIES B IS THE PRIORITY. These companies have found PMF, are scaling their sales motion, 
and still have meaningful equity upside. Identify the best 6-10 Series B companies.
Also identify 2-4 notable companies at each of Series A, C, and D+ that are exceptional opportunities.

For each company, provide SPECIFIC, REAL, SOURCED data — not generic descriptions.
Include actual funding amounts, dates, investors, and growth metrics where available.

Return EXACTLY this JSON between PREIPO_START and PREIPO_END markers. No text outside:

PREIPO_START
{
  "generated_at": "${new Date().toISOString()}",
  "market_context": "2-3 sentences on the current funding climate and what it means for sales job seekers right now",
  "series_b_thesis": "2-3 sentences on why Series B is the sweet spot for sales professionals specifically right now — comp, equity, growth trajectory",
  "companies": [
    {
      "company_name": "Company Name",
      "company_url": "https://company.com or null",
      "funding_stage": "Series B",
      "vertical": "AI Security / Revenue Intelligence / etc",
      "founded_year": 2019,
      "total_raised": "$85M or null if unknown",
      "last_round_size": "$50M Series B or null",
      "last_round_date": "March 2024 or null",
      "lead_investors": ["Sequoia", "a16z"],
      "why_explosive_now": "Specific, sourced reason this company is a rocket ship right now — recent announcement, metric, or signal",
      "hypergrowth_signals": ["3x ARR growth YoY", "Headcount doubled in 12 months", "New CRO hired from Salesforce"],
      "sales_opportunity": "Why a sales professional should care — quota attainability, territory availability, ICP clarity, expansion motion",
      "likely_roles": ["Enterprise AE", "Mid-Market AE", "Sales Engineer"],
      "estimated_ote_range": "$250K-$350K OTE or null if unknown",
      "equity_upside": "Why equity here is meaningful — stage, valuation trajectory, IPO likelihood",
      "ipo_timeline_guess": "12-18 months / 2-3 years / Unknown",
      "risk_flags": ["Single product", "Crowded space", "Burn rate concern"],
      "momentum_score": 88,
      "action": "apply_now",
      "source_citations": [
        { "title": "Source headline", "url": "https://source.url" }
      ]
    }
  ]
}
PREIPO_END

momentum_score: 1-100. 90+ = must-act-now. 75-89 = strong opportunity. 60-74 = watch closely. Under 60 = monitor.
action values: "apply_now" | "watch_closely" | "network_in" | "monitor"

Find at least 14 total companies. Include real companies with real data — no hypothetical or generic examples.`;
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

// ── Core generation ────────────────────────────────────────────────────────────

const CLAUDE_MODEL = 'claude-sonnet-4-6';

export async function generatePreIpo(criteria: PreIpoCriteria): Promise<PreIpoResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey });
  const prompt = buildPreIpoPrompt(criteria);

  console.log(`[PreIPO] Generating with ${CLAUDE_MODEL} + web search`);

  const response = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any[],
    messages: [{ role: 'user', content: prompt }],
  });

  const rawText = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n');

  const groundingCount = response.content.filter((b: any) => b.type === 'tool_use').length;

  const start = rawText.indexOf('PREIPO_START');
  if (start === -1) throw new Error('PREIPO_START marker not found in response');

  // PREIPO_END may be missing if output was truncated — slice to end if absent
  const end = rawText.indexOf('PREIPO_END');
  const rawJson = end !== -1
    ? rawText.slice(start + 'PREIPO_START'.length, end).trim()
    : rawText.slice(start + 'PREIPO_START'.length).trim();

  let parsed: PreIpoResult;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    console.warn('[PreIPO] JSON truncated, attempting repair…');
    try {
      parsed = JSON.parse(repairTruncatedJson(rawJson));
      console.log(`[PreIPO] Repair succeeded — ${parsed.companies?.length ?? 0} companies`);
    } catch (repairErr) {
      throw new Error(`JSON parse failed even after repair: ${repairErr}. Preview: ${rawJson.slice(0, 300)}`);
    }
  }

  parsed.model_used = CLAUDE_MODEL;
  parsed.grounding_sources_count = groundingCount;

  // Sort by momentum_score descending
  parsed.companies.sort((a, b) => (b.momentum_score ?? 0) - (a.momentum_score ?? 0));

  console.log(`[PreIPO] Success: ${parsed.companies.length} companies via ${CLAUDE_MODEL}`);
  return parsed;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

export async function initPreIpoDB(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS preipo_intel (
      id           SERIAL PRIMARY KEY,
      result_json  JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getLatestPreIpo(pool: Pool): Promise<{ data: PreIpoResult; stale: boolean } | null> {
  const { rows } = await pool.query(
    'SELECT result_json, generated_at FROM preipo_intel ORDER BY generated_at DESC LIMIT 1'
  );
  if (!rows[0]) return null;
  const ageHours = (Date.now() - new Date(rows[0].generated_at).getTime()) / 3_600_000;
  return { data: rows[0].result_json as PreIpoResult, stale: ageHours > 24 };
}

export async function savePreIpo(pool: Pool, result: PreIpoResult): Promise<void> {
  await pool.query('INSERT INTO preipo_intel (result_json, generated_at) VALUES ($1, NOW())', [JSON.stringify(result)]);
  await pool.query('DELETE FROM preipo_intel WHERE id NOT IN (SELECT id FROM preipo_intel ORDER BY generated_at DESC LIMIT 5)');
}
