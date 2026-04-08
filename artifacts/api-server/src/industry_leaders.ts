/**
 * Industry Leaders Intelligence Engine
 *
 * Uses Claude to identify the top 5 sales-led companies in each major B2B sector.
 * Split into two parallel Claude calls (6 sectors each) to stay within the 8K
 * output token ceiling per call — avoids JSON truncation that plagued the single-call approach.
 */

import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndustryLeaderCompany {
  name: string;
  website: string | null;
  ticker: string | null;
  is_public: boolean;
  stage: string | null;
  rank: number;
  tagline: string;
  why_sales_led: string;
  growth_signal: string;
  ote_range: string | null;
  rep_quality: string;
  action: 'apply_now' | 'network_in' | 'watch' | 'monitor';
}

export interface IndustrySector {
  sector: string;
  emoji: string;
  market_context: string;
  companies: IndustryLeaderCompany[];
}

export interface IndustryLeadersResult {
  generated_at: string;
  market_overview: string;
  sectors: IndustrySector[];
  model_used: string | null;
}

// ── DB helpers ────────────────────────────────────────────────────────────────

export async function initIndustryLeadersDB(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS industry_leaders (
      id           SERIAL PRIMARY KEY,
      result_json  JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getLatestIndustryLeaders(pool: Pool): Promise<{ data: IndustryLeadersResult; stale: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT result_json, generated_at FROM industry_leaders ORDER BY generated_at DESC LIMIT 1`
  );
  if (!rows[0]) return null;
  const ageMs = Date.now() - new Date(rows[0].generated_at).getTime();
  const stale = ageMs > 7 * 24 * 60 * 60 * 1000;
  return { data: rows[0].result_json as IndustryLeadersResult, stale };
}

export async function saveIndustryLeaders(pool: Pool, result: IndustryLeadersResult): Promise<void> {
  await pool.query(
    `INSERT INTO industry_leaders (result_json, generated_at) VALUES ($1, NOW())`,
    [JSON.stringify(result)]
  );
  await pool.query(
    `DELETE FROM industry_leaders WHERE id NOT IN (SELECT id FROM industry_leaders ORDER BY generated_at DESC LIMIT 5)`
  );
}

// ── Sectors ──────────────────────────────────────────────────────────────────

const SECTORS = [
  { sector: 'AI Infrastructure',                    emoji: '\uD83E\uDD16' },
  { sector: 'Cybersecurity',                        emoji: '\uD83D\uDD10' },
  { sector: 'SaaS / Enterprise Software',           emoji: '\u2601\uFE0F' },
  { sector: 'Data & Analytics / Database',          emoji: '\uD83D\uDDC4\uFE0F' },
  { sector: 'Data Center & Cloud Infrastructure',   emoji: '\uD83C\uDFD7\uFE0F' },
  { sector: 'Networking',                           emoji: '\uD83C\uDF10' },
  { sector: 'Storage',                              emoji: '\uD83D\uDCBE' },
  { sector: 'Advanced Materials & Semiconductors',  emoji: '\u2697\uFE0F' },
  { sector: 'Pharma / Biotech',                     emoji: '\uD83E\uDDEC' },
  { sector: 'Utilities & Energy Tech',              emoji: '\u26A1' },
  { sector: 'Industrials & Manufacturing Tech',     emoji: '\uD83C\uDFED' },
  { sector: 'FinTech & Financial Services',         emoji: '\uD83D\uDCB0' },
];

// ── Prompt builder ────────────────────────────────────────────────────────────

function buildBatchPrompt(batchSectors: typeof SECTORS, includeOverview: boolean): string {
  const sectorList = batchSectors.map(s => `- ${s.sector}`).join('\n');
  const overviewInstruction = includeOverview
    ? 'Also return "market_overview": 2-3 sentences on the current macro environment for B2B sales pros across all sectors — what\'s hot, where money is flowing, what\'s cooling off.'
    : 'Return "market_overview": "" (empty string — not needed for this batch).';

  return `You are a senior enterprise sales recruiter and market intelligence analyst with deep knowledge of the B2B technology landscape as of early 2026.

Task: For each sector below, identify the TOP 5 companies that sales professionals most want to work at RIGHT NOW. Exactly 5 per sector.

CRITERIA:
1. Sales-led growth engine (enterprise reps are core to revenue — not PLG/self-serve)
2. Strong market momentum (hypergrowth, major wins, aggressive hiring, recent funding, category dominance)
3. Above-market OTE for enterprise AEs
4. Elite reputation as a place to sell — quota attainment, training, comp culture

Sectors:
${sectorList}

For EACH company, return these exact fields (keep values concise):
- name: company name
- website: domain only e.g. "paloaltonetworks.com"
- ticker: stock ticker if public, null if private
- is_public: boolean
- stage: funding stage if private e.g. "Series C", null if public
- rank: 1-based rank within sector (1 = top pick)
- tagline: max 12 words — what they do and why they matter
- why_sales_led: 1 sentence — why their sales motion is elite
- growth_signal: 1 concrete recent signal (funding, ARR, hiring surge)
- ote_range: AE OTE e.g. "$280K-$380K" or null if unknown
- rep_quality: 1 sentence — what caliber of rep thrives here
- action: "apply_now" | "network_in" | "watch" | "monitor"

${overviewInstruction}

Return ONLY valid JSON (no markdown, no code fences):
{
  "market_overview": "...",
  "sectors": [
    {
      "sector": "sector name here",
      "emoji": "emoji here",
      "market_context": "1 sentence on what is happening in this sector for sales right now",
      "companies": [
        {
          "name": "...", "website": "...", "ticker": null, "is_public": false,
          "stage": "...", "rank": 1, "tagline": "...", "why_sales_led": "...",
          "growth_signal": "...", "ote_range": "...", "rep_quality": "...", "action": "apply_now"
        }
      ]
    }
  ]
}`;
}

// ── Claude call helper ────────────────────────────────────────────────────────

async function callClaude(ac: any, prompt: string): Promise<any> {
  const response = await ac.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });
  const raw = response.content[0]?.type === 'text' ? (response.content[0] as any).text : '';
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error(`No JSON found in Claude response. stop_reason: ${response.stop_reason}. Raw start: ${raw.slice(0, 400)}`);
  }
  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse Claude JSON: ${e}. Raw: ${raw.slice(0, 500)}`);
  }
}

// ── Sector parser ─────────────────────────────────────────────────────────────

function parseSectors(parsed: any): IndustrySector[] {
  return (parsed.sectors || []).map((s: any) => ({
    sector: s.sector || '',
    emoji: SECTORS.find(x => x.sector === s.sector)?.emoji || s.emoji || '\uD83C\uDFE2',
    market_context: s.market_context || '',
    companies: (s.companies || []).map((c: any, i: number) => ({
      name: c.name || '',
      website: c.website || null,
      ticker: c.ticker || null,
      is_public: Boolean(c.is_public),
      stage: c.stage || null,
      rank: c.rank || (i + 1),
      tagline: c.tagline || '',
      why_sales_led: c.why_sales_led || '',
      growth_signal: c.growth_signal || '',
      ote_range: c.ote_range || null,
      rep_quality: c.rep_quality || '',
      action: (['apply_now', 'network_in', 'watch', 'monitor'].includes(c.action) ? c.action : 'watch') as IndustryLeaderCompany['action'],
    })),
  }));
}

// ── Main generation — two parallel batches of 6 sectors each ─────────────────

export async function generateIndustryLeaders(): Promise<IndustryLeadersResult> {
  const { aiRouter: ac } = await import('./ai_router.js');

  const batch1 = SECTORS.slice(0, 6);   // AI Infra → Networking
  const batch2 = SECTORS.slice(6);      // Storage → FinTech

  // Run both batches in parallel — each stays well inside the 8K output limit
  const [parsed1, parsed2] = await Promise.all([
    callClaude(ac, buildBatchPrompt(batch1, true)),   // batch 1 generates market_overview
    callClaude(ac, buildBatchPrompt(batch2, false)),  // batch 2 skips it
  ]);

  return {
    generated_at: new Date().toISOString(),
    market_overview: parsed1.market_overview || '',
    sectors: [...parseSectors(parsed1), ...parseSectors(parsed2)],
    model_used: 'claude-haiku-4-5',
  };
}
