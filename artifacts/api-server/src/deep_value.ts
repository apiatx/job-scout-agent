/**
 * Deep Value Intelligence Engine
 *
 * Uses Gemini + Google Search grounding to identify cutting-edge infrastructure
 * companies with the clearest "why you need this" customer value proposition.
 * Focus: non-SaaS infrastructure — Cloud, AI Infra, Data/Database, HPC, Semiconductors,
 * Photonics, Networking, Storage, Datacenter.
 *
 * The EXACT user prompt is passed to Gemini, with a structured JSON output wrapper.
 */

import { GoogleGenAI, type GroundingChunk } from '@google/genai';
import type { Pool } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DeepValueOpenRole {
  title: string;
  apply_url: string | null;
  location: string | null;
}

export interface DeepValueCompany {
  name: string;
  website: string | null;
  category: string;
  stage: string | null;
  ticker: string | null;
  is_public: boolean;
  tagline: string;
  why_you_need_this: string;
  customer_pain: string;
  growth_signal: string;
  notable_customers: string[];
  open_roles: DeepValueOpenRole[];
  has_open_roles: boolean;
  source_citations: Array<{ title: string; url: string }>;
}

export interface DeepValueResult {
  generated_at: string;
  market_summary: string;
  companies: DeepValueCompany[];
  model_used: string | null;
  grounding_sources_count: number;
}

// ── Model waterfall ────────────────────────────────────────────────────────────

const BUILTIN_CANDIDATES = [
  { modelName: 'gemini-3-flash-preview',   note: 'Gemini 3 Flash' },
  { modelName: 'gemini-3.1-pro-preview',   note: 'Gemini 3.1 Pro' },
  { modelName: 'gemini-flash-latest',      note: 'Gemini Flash (alias)' },
  { modelName: 'gemini-pro-latest',        note: 'Gemini Pro (alias)' },
];

function isModelUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes('model not found') || msg.includes('404') || msg.includes('not found') ||
    msg.includes('not available') || msg.includes('unsupported model') ||
    msg.includes('invalid model') || msg.includes('deprecated') ||
    msg.includes('503') || msg.includes('unavailable') || msg.includes('high demand') ||
    msg.includes('try again later') || msg.includes('overloaded') ||
    msg.includes('resource_exhausted') || msg.includes('429');
}

function buildCandidateChain() {
  const envModel = process.env.GEMINI_MODEL?.trim();
  if (!envModel) return [...BUILTIN_CANDIDATES];
  const deduped = BUILTIN_CANDIDATES.filter(c => c.modelName !== envModel);
  return [{ modelName: envModel, note: 'env override' }, ...deduped];
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

export async function initDeepValueDB(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deep_value (
      id           SERIAL PRIMARY KEY,
      result_json  JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS company_job_scan_results (
      id           SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL UNIQUE,
      jobs         JSONB NOT NULL DEFAULT '[]',
      scanned_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

export async function getLatestDeepValue(pool: Pool): Promise<{ data: DeepValueResult; stale: boolean } | null> {
  const { rows } = await pool.query(
    `SELECT result_json, generated_at FROM deep_value ORDER BY generated_at DESC LIMIT 1`
  );
  if (!rows[0]) return null;
  const ageMs = Date.now() - new Date(rows[0].generated_at).getTime();
  const stale = ageMs > 24 * 60 * 60 * 1000;
  return { data: rows[0].result_json as DeepValueResult, stale };
}

export async function saveDeepValue(pool: Pool, result: DeepValueResult): Promise<void> {
  await pool.query(
    `INSERT INTO deep_value (result_json, generated_at) VALUES ($1, NOW())`,
    [JSON.stringify(result)]
  );
  await pool.query(
    `DELETE FROM deep_value WHERE id NOT IN (SELECT id FROM deep_value ORDER BY generated_at DESC LIMIT 5)`
  );
}

// ── Company Job Scan helpers ───────────────────────────────────────────────────

export interface CompanyJobScanEntry {
  company_name: string;
  jobs: Array<{ title: string; apply_url: string | null; location: string | null }>;
  scanned_at: string;
}

export async function getCompanyJobScanResults(pool: Pool): Promise<CompanyJobScanEntry[]> {
  const { rows } = await pool.query(
    `SELECT company_name, jobs, scanned_at FROM company_job_scan_results ORDER BY company_name`
  );
  return rows.map(r => ({
    company_name: r.company_name,
    jobs: r.jobs as any[],
    scanned_at: r.scanned_at,
  }));
}

export async function upsertCompanyJobScan(
  pool: Pool,
  companyName: string,
  jobs: Array<{ title: string; apply_url: string | null; location: string | null }>
): Promise<void> {
  await pool.query(
    `INSERT INTO company_job_scan_results (company_name, jobs, scanned_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (company_name) DO UPDATE SET jobs = $2, scanned_at = NOW()`,
    [companyName, JSON.stringify(jobs)]
  );
}

// ── Gemini generation ──────────────────────────────────────────────────────────

export async function generateDeepValue(criteria: {
  target_roles: string[];
  locations: string[];
  min_salary: number | null;
}): Promise<DeepValueResult> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY not set — configure it in Settings');
  }

  const ai = new GoogleGenAI({ apiKey });
  const candidates = buildCandidateChain();

  // The EXACT user-specified prompt + structured JSON output instructions
  const userPromptCore = `What cutting edge companies have the clearest "why you need this" case when talking to customers. Only looking at non-saas tools, moreso 'infrastructure' like Cloud infra, AI Infra, data/database, high performance storage, HPC/Compute, semiconductors, photonics, networking, datacenter, etc.`;

  const fullPrompt = `${userPromptCore}

You are a senior enterprise sales intelligence analyst. Based on the above question, identify the TOP 15-25 companies that best match this criteria right now in early 2026. These should be the most compelling infrastructure companies with an undeniable customer value proposition — where the "why you need this" is crystal clear and urgent.

For each company, ALSO search for any currently open sales roles (Account Executive, Sales Engineer, Strategic AE, Enterprise Sales, Regional Sales Manager, Director of Sales, VP Sales, etc.) and return any current job posting URLs you can find.

Also check what target roles the user is looking for: ${(criteria.target_roles || []).join(', ') || 'Enterprise Account Executive, Sales Engineer'}.

Return ONLY valid JSON — no markdown, no prose, no code blocks:
{
  "market_summary": "2-3 sentences on why infrastructure has the most defensible 'why you need this' value props right now",
  "companies": [
    {
      "name": "company name",
      "website": "their main domain e.g. nvidia.com",
      "category": "one of: AI Infrastructure | Cloud Infrastructure | Data/Database | HPC/Compute | Semiconductor | Photonics | Networking | High-Performance Storage | Data Center | Advanced Materials",
      "stage": "if private: Series A/B/C/D+/Late Stage; if public: null",
      "ticker": "stock ticker if public, else null",
      "is_public": true or false,
      "tagline": "one punchy line — what they do and why it matters (max 15 words)",
      "why_you_need_this": "the clearest 1-2 sentence customer value prop — why a buyer MUST have this",
      "customer_pain": "what specific pain/problem they solve in 1 sentence",
      "growth_signal": "most compelling recent signal — funding, customer win, product launch, market expansion",
      "notable_customers": ["Customer1", "Customer2"],
      "open_roles": [
        { "title": "job title", "apply_url": "direct apply URL or careers page URL or null", "location": "Remote / City or null" }
      ],
      "has_open_roles": true or false,
      "source_citations": [{ "title": "page title", "url": "url" }]
    }
  ]
}`;

  let lastError: unknown;

  for (const candidate of candidates) {
    try {
      console.log(`[DeepValue] Trying model: ${candidate.modelName} (${candidate.note})`);

      const response = await ai.models.generateContent({
        model: candidate.modelName,
        contents: fullPrompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.3,
          maxOutputTokens: 8192,
        },
      });

      const raw = response.text ?? '';

      // Collect grounding sources
      const groundingChunks: GroundingChunk[] =
        (response.candidates?.[0]?.groundingMetadata?.groundingChunks as GroundingChunk[] | undefined) ?? [];
      const sourceCount = groundingChunks.length;

      console.log(`[DeepValue] Model ${candidate.modelName} — ${raw.length} chars, ${sourceCount} grounding sources`);

      // Parse JSON — strip markdown code blocks if present
      let jsonStr = raw.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error(`No JSON object found in response. Preview: ${raw.slice(0, 300)}`);

      let parsed: any;
      try {
        parsed = JSON.parse(jsonMatch[0]);
      } catch (parseErr) {
        throw new Error(`JSON parse failed: ${parseErr}. Preview: ${jsonMatch[0].slice(0, 300)}`);
      }

      const companies: DeepValueCompany[] = (parsed.companies || []).map((c: any) => ({
        name: c.name || '',
        website: c.website || null,
        category: c.category || 'Infrastructure',
        stage: c.stage || null,
        ticker: c.ticker || null,
        is_public: Boolean(c.is_public),
        tagline: c.tagline || '',
        why_you_need_this: c.why_you_need_this || '',
        customer_pain: c.customer_pain || '',
        growth_signal: c.growth_signal || '',
        notable_customers: Array.isArray(c.notable_customers) ? c.notable_customers : [],
        open_roles: Array.isArray(c.open_roles)
          ? c.open_roles.map((r: any) => ({ title: r.title || '', apply_url: r.apply_url || null, location: r.location || null }))
          : [],
        has_open_roles: Boolean(c.has_open_roles) || (Array.isArray(c.open_roles) && c.open_roles.length > 0),
        source_citations: Array.isArray(c.source_citations)
          ? c.source_citations.map((s: any) => ({ title: s.title || '', url: s.url || '' }))
          : [],
      }));

      return {
        generated_at: new Date().toISOString(),
        market_summary: parsed.market_summary || '',
        companies,
        model_used: candidate.modelName,
        grounding_sources_count: sourceCount,
      };

    } catch (err) {
      lastError = err;
      if (isModelUnavailableError(err)) {
        console.warn(`[DeepValue] Model ${candidate.modelName} unavailable, trying next…`);
        continue;
      }
      throw err;
    }
  }

  throw new Error(`All Gemini models exhausted. Last error: ${lastError}`);
}

// ── Watchlist job scan ─────────────────────────────────────────────────────────

export async function scanWatchlistCompanyJobs(
  pool: Pool,
  companyName: string,
  criteria: { target_roles: string[]; locations: string[] }
): Promise<Array<{ title: string; apply_url: string | null; location: string | null }>> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const candidates = buildCandidateChain();

  const roles = (criteria.target_roles || []).join(', ') || 'Enterprise Account Executive, Sales Engineer, Strategic Account Executive';
  const locs = (criteria.locations || ['Remote']).join(', ');

  const prompt = `Search for currently open sales job postings at ${companyName} that match these criteria:
- Target roles: ${roles}
- Locations: ${locs}

Return ONLY valid JSON array (no markdown, no prose):
[
  { "title": "exact job title", "apply_url": "direct URL to apply or careers page URL", "location": "city or Remote" }
]

If no matching open roles found, return: []
Only include REAL, currently open positions. Do not make up job listings.`;

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const response = await ai.models.generateContent({
        model: candidate.modelName,
        contents: prompt,
        config: {
          tools: [{ googleSearch: {} }],
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      });

      const raw = response.text ?? '';
      let jsonStr = raw.trim();
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1].trim();
      const arrMatch = jsonStr.match(/\[[\s\S]*\]/);
      if (!arrMatch) return [];

      const parsed = JSON.parse(arrMatch[0]);
      if (!Array.isArray(parsed)) return [];
      return parsed.map((r: any) => ({
        title: r.title || '',
        apply_url: r.apply_url || null,
        location: r.location || null,
      }));
    } catch (err) {
      lastError = err;
      if (isModelUnavailableError(err)) { continue; }
      console.error(`[WatchlistScan] Error scanning ${companyName}:`, err);
      return [];
    }
  }
  console.error(`[WatchlistScan] All models exhausted for ${companyName}:`, lastError);
  return [];
}
