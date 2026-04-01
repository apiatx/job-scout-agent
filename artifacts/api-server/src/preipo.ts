/**
 * Pre-IPO Intelligence Engine
 *
 * Uses Gemini + Google Search grounding to identify top Series A/B/C/D companies
 * experiencing hypergrowth — ranked by opportunity for sales professionals right now.
 *
 * Series B is the primary target: proven PMF, scaling sales motion, high OTE potential,
 * equity still meaningful before an IPO or acquisition event.
 *
 * Same model waterfall as career_intel.ts.
 */

import { GoogleGenAI, type GroundingChunk } from '@google/genai';
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

// ── Model waterfall (same as career_intel.ts) ─────────────────────────────────

interface ModelCandidate { modelName: string; note: string; }

const BUILTIN_CANDIDATES: ModelCandidate[] = [
  { modelName: 'gemini-3-flash-preview',  note: 'Gemini 3 Flash — speed/cost default' },
  { modelName: 'gemini-3.1-pro-preview',  note: 'Gemini 3.1 Pro — quality mode' },
  { modelName: 'gemini-flash-latest',     note: 'alias — latest Flash' },
  { modelName: 'gemini-pro-latest',       note: 'alias — latest Pro' },
];

function isModelUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('model not found') || msg.includes('404') || msg.includes('not found') ||
    msg.includes('not available') || msg.includes('unsupported model') ||
    msg.includes('invalid model') || msg.includes('deprecated') ||
    msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand') ||
    msg.includes('try again later') || msg.includes('overloaded') ||
    msg.includes('resource_exhausted') || msg.includes('429') || msg.includes('timeout');
}

function buildCandidateChain(): ModelCandidate[] {
  const envModel = process.env.GEMINI_MODEL?.trim();
  if (!envModel) return [...BUILTIN_CANDIDATES];
  const deduped = BUILTIN_CANDIDATES.filter(c => c.modelName !== envModel);
  return [{ modelName: envModel, note: 'user-configured via GEMINI_MODEL env var' }, ...deduped];
}

// ── Prompt builder ─────────────────────────────────────────────────────────────

function buildPreIpoPrompt(criteria: PreIpoCriteria): string {
  const roles   = criteria.target_roles.slice(0, 6).join(', ')  || 'Account Executive, Sales Manager, Enterprise AE';
  const inds    = criteria.industries.slice(0, 5).join(', ')    || 'SaaS, AI, Cybersecurity, Fintech, Data Infrastructure';
  const niches  = criteria.vertical_niches.slice(0, 4).join(', ');
  const today   = new Date().toISOString().split('T')[0];

  return `You are a top-tier venture capital analyst and career intelligence researcher.
Today's date: ${today}

Your job: use Google Search to identify the most explosive, high-growth private companies at Series A, B, C, and D stages that a senior sales professional should be targeting RIGHT NOW.

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

// ── Core generation ────────────────────────────────────────────────────────────

export async function generatePreIpo(criteria: PreIpoCriteria): Promise<PreIpoResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const prompt = buildPreIpoPrompt(criteria);
  const chain = buildCandidateChain();

  let lastErr: unknown;
  for (const candidate of chain) {
    try {
      console.log(`[PreIPO] Trying model: ${candidate.modelName}`);
      const response = await ai.models.generateContent({
        model: candidate.modelName,
        contents: prompt,
        config: { tools: [{ googleSearch: {} }] },
      });

      const rawText: string = response.text ?? '';
      const start = rawText.indexOf('PREIPO_START');
      const end   = rawText.indexOf('PREIPO_END');
      if (start === -1 || end === -1) throw new Error('Markers not found in response');

      const jsonStr = rawText.slice(start + 'PREIPO_START'.length, end).trim();
      const parsed: PreIpoResult = JSON.parse(jsonStr);

      // Count grounding sources
      let groundingCount = 0;
      try {
        const chunks = (response as unknown as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: GroundingChunk[] } }> })
          ?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
        groundingCount = chunks.length;
      } catch { /* ignore */ }

      parsed.model_used = candidate.modelName;
      parsed.grounding_sources_count = groundingCount;

      // Sort by momentum_score descending
      parsed.companies.sort((a, b) => (b.momentum_score ?? 0) - (a.momentum_score ?? 0));

      console.log(`[PreIPO] Success: ${parsed.companies.length} companies via ${candidate.modelName}`);
      return parsed;
    } catch (err) {
      console.error(`[PreIPO] ${candidate.modelName} failed:`, err);
      lastErr = err;
      if (!isModelUnavailableError(err)) break;
    }
  }
  throw lastErr ?? new Error('All Gemini models failed for Pre-IPO generation');
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
