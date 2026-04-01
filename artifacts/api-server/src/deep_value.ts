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

// [Removed] Gemini import (GoogleGenAI)
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
    msg.includes('resource_exhausted') || msg.includes('429') || msg.includes('timeout');
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

export async function generateDeepValue(_criteria: {
  target_roles: string[];
  locations: string[];
  min_salary: number | null;
}): Promise<DeepValueResult> {
  // [Removed] Gemini Deep Value generation
  throw new Error('[Removed] Deep Value feature requires Gemini which has been removed');
}

// ── Watchlist job scan ─────────────────────────────────────────────────────────

export async function scanWatchlistCompanyJobs(
  _pool: Pool,
  companyName: string,
  _criteria: { target_roles: string[]; locations: string[] }
): Promise<Array<{ title: string; apply_url: string | null; location: string | null }>> {
  // [Removed] Gemini watchlist company job scan
  console.log(`[WatchlistScan] ${companyName}: Gemini removed — returning empty`);
  return [];
}
