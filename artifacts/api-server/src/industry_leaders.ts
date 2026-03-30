/**
 * Industry Leaders Intelligence Engine
 *
 * Uses Claude to identify the top 5-10 sales-led companies in each major B2B sector.
 * The focus: companies with genuine sales-driven growth engines that sales reps want to
 * work at — clear leaders, fast-rising contenders, and buzzy names dominating the category.
 *
 * Sectors: SaaS, Cybersecurity, Data Center, Storage, Data/Database, Networking,
 * Advanced Materials, AI Infrastructure, Pharma/Biotech, Utilities, Industrials, and more.
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
  const stale = ageMs > 7 * 24 * 60 * 60 * 1000; // stale after 7 days
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

// ── Claude generation ─────────────────────────────────────────────────────────

const SECTORS = [
  { sector: 'AI Infrastructure', emoji: '🤖' },
  { sector: 'Cybersecurity', emoji: '🔐' },
  { sector: 'SaaS / Enterprise Software', emoji: '☁️' },
  { sector: 'Data & Analytics / Database', emoji: '🗄️' },
  { sector: 'Data Center & Cloud Infrastructure', emoji: '🏗️' },
  { sector: 'Networking', emoji: '🌐' },
  { sector: 'Storage', emoji: '💾' },
  { sector: 'Advanced Materials & Semiconductors', emoji: '⚗️' },
  { sector: 'Pharma / Biotech', emoji: '🧬' },
  { sector: 'Utilities & Energy Tech', emoji: '⚡' },
  { sector: 'Industrials & Manufacturing Tech', emoji: '🏭' },
  { sector: 'FinTech & Financial Services', emoji: '💰' },
];

export async function generateIndustryLeaders(): Promise<IndustryLeadersResult> {
  const Sdk = (await import('@anthropic-ai/sdk')).default;
  const ac = new Sdk({ apiKey: process.env.ANTHROPIC_API_KEY });

  const sectorList = SECTORS.map(s => `- ${s.sector}`).join('\n');

  const prompt = `You are a senior enterprise sales recruiter and market intelligence analyst with deep knowledge of the B2B technology and industrial landscape as of early 2026.

Your task: For each sector below, identify the TOP 5–10 companies that sales professionals most want to work at RIGHT NOW. These should be the shining stars — clear category leaders, fast-growing challengers, and companies with elite sales cultures and strong commission upside.

CRITICAL CRITERIA — every company must have:
1. A proven sales-led growth engine (not PLG, not pure self-serve — enterprise sales reps are core to their revenue)
2. Serious market momentum right now (hypergrowth, major contract wins, aggressive hiring, recent funding, category dominance)
3. Strong or above-market OTE potential for enterprise sales reps
4. A reputation in the industry as a top place to sell — known quota attainment, training, culture

Sectors to cover:
${sectorList}

For EACH company return:
- name: company name
- website: their main website URL (e.g. "paloaltonetworks.com")
- ticker: stock ticker if public (null if private)
- is_public: boolean
- stage: if private, funding stage like "Series C", "Series D+", "Late Stage Private" — null if public
- rank: 1-based rank within the sector (1 = #1 pick)
- tagline: one punchy sentence on what they do / why they matter (max 15 words)
- why_sales_led: 1-2 sentences explaining why their sales motion is world-class and why reps love it
- growth_signal: the single most compelling recent signal (e.g. "Raised $500M Series D, 180% ARR growth, hiring 400 AEs in 2025")
- ote_range: realistic OTE range for a mid-market or enterprise AE (e.g. "$280K–$380K") or null if unknown
- rep_quality: one sentence on what caliber of rep excels here and what makes their process distinctive
- action: one of "apply_now" | "network_in" | "watch" | "monitor"
  - apply_now = actively hiring, hot right now, get in
  - network_in = great company, build relationships before applying
  - watch = great trajectory, keep on radar
  - monitor = solid but check timing

Also return:
- market_overview: 2-3 sentence synthesis of the current macro environment for B2B sales professionals across these sectors — what's hot, where money is flowing, what's cooling off

Return ONLY valid JSON in this exact structure (no markdown, no prose):
{
  "market_overview": "...",
  "sectors": [
    {
      "sector": "AI Infrastructure",
      "emoji": "🤖",
      "market_context": "1-2 sentences on what's happening in this sector right now for sales",
      "companies": [ { ...company fields... }, ... ]
    },
    ...
  ]
}`;

  const response = await ac.messages.create({
    model: 'claude-opus-4-5',
    max_tokens: 16000,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = response.content[0].type === 'text' ? response.content[0].text : '';
  
  let parsed: any;
  try {
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON found in response');
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`Failed to parse Claude response: ${e}. Raw: ${raw.slice(0, 500)}`);
  }

  const sectors: IndustrySector[] = (parsed.sectors || []).map((s: any) => ({
    sector: s.sector || '',
    emoji: SECTORS.find(x => x.sector === s.sector)?.emoji || s.emoji || '🏢',
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
      action: c.action || 'watch',
    })),
  }));

  return {
    generated_at: new Date().toISOString(),
    market_overview: parsed.market_overview || '',
    sectors,
    model_used: 'claude-opus-4-5',
  };
}
