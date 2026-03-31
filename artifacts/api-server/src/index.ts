import express, { type Request, type Response } from 'express';
import pg from 'pg';
import multer from 'multer';
import * as pdfParseLib from 'pdf-parse';
const pdfParse = (pdfParseLib as any).default ?? pdfParseLib;
import mammoth from 'mammoth';
import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, UnderlineType } from 'docx';
import { scrapeGreenhouseJobs, scrapeLeverJobs, scrapeWorkdayJobs, runJobSpyScraper, proxyConfigured } from './scraper.js';
import type { ScrapedJob } from './scraper.js';
import { runGeminiJobDiscovery, deduplicateJobLists, isDirectCompanyUrl, normalizeUrl as normalizeJobUrl } from './gemini_discovery.js';
import { runCanonicalResolutionInBackground, computeLinkConfidence, classifySourceTrust, enrichJobsPreScoring } from './link_validator.js';
import { generateCareerIntel } from './career_intel.js';
import type { CareerIntelCriteria } from './career_intel.js';
import { generatePreIpo, initPreIpoDB, getLatestPreIpo, savePreIpo } from './preipo.js';
import type { PreIpoCriteria } from './preipo.js';
import { generateIndustryLeaders, initIndustryLeadersDB, getLatestIndustryLeaders, saveIndustryLeaders } from './industry_leaders.js';
import {
  generateDeepValue, initDeepValueDB, getLatestDeepValue, saveDeepValue,
  scanWatchlistCompanyJobs, upsertCompanyJobScan, getCompanyJobScanResults
} from './deep_value.js';
import { generateJobMarketPulse, buildStats } from './job_market_pulse.js';
import type { JobMarketPulseResult, ScoutCompanyStat } from './job_market_pulse.js';
import { refreshIndustryNews, getLatestNews } from './industry_news.js';
import {
  initPositioningDB, getProfile, saveProfile, getStories, saveStory, deleteStory,
  getOutputs, generateOutputs, getObjections, generateObjections,
  getNarrative, saveNarrative, draftNarrative
} from './positioning.js';
import { scoreJobsWithClaude, tailorResumeWithClaude, researchCompanyWithClaude, filterUnsafeCompanies, rescoreJobOpportunity, computeTier, generateCoverLetterWithClaude, tailorResumeV2WithClaude, detectTerritory, analyzeTerritoryContext, getCompanyMomentum, DEFAULT_COVER_LETTER_INSTRUCTIONS } from './agent.js';
import type { MomentumScore } from './agent.js';
import type { SubScores, OpportunityTier, TierSettings, TailoringAnalysis } from './agent.js';
import { estimateSalary, type SalaryEstimate } from './lib/salary.js';
// RepVue: link-out only (no scraping — RepVue blocks automated requests)

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT) || 8080;
const AUTO_RUN_CHECK_MS = 15 * 60 * 1000;   // check every 15 min
const AUTO_RUN_THRESHOLD_H = 20;             // trigger if no run in 20 hours

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json({ limit: '2mb' }));

// Multer — in-memory storage for resume file uploads (PDF / DOCX)
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Health check — MUST be the very first route for Replit ────────────────
app.get('/health', (_req, res) => { res.status(200).json({ status: 'ok' }); });
app.get('/api/healthz', (_req, res) => { res.status(200).json({ status: 'ok' }); });

// Proxy status — shows whether JOBSPY_PROXY is configured WITHOUT exposing credentials.
// Primary source: JOBSPY_PROXY Replit Secret.
// Fallback source: proxy_url field in Settings (stored in DB).
app.get('/api/proxy-status', async (_req, res: Response) => {
  try {
    // Check Settings fallback (Replit Secret is checked directly inside proxyConfigured)
    const { rows } = await pool.query('SELECT proxy_url FROM criteria LIMIT 1');
    const settingsProxy = (rows[0]?.proxy_url ?? '').trim();

    const { configured, source } = proxyConfigured(settingsProxy);

    const warning = configured
      ? null
      : 'JOBSPY_PROXY not set — Glassdoor and ZipRecruiter are disabled. Add it in Replit Secrets (key: JOBSPY_PROXY) or in Settings → Proxy URL.';

    res.json({
      configured,
      source,                               // "env" | "settings" | null
      sources_unlocked: configured
        ? ['LinkedIn', 'Indeed', 'Glassdoor', 'ZipRecruiter']
        : ['LinkedIn', 'Indeed'],
      // NOTE: proxy URL itself is intentionally NOT returned — credentials must not be exposed
      warning,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Gmail OAuth config ───────────────────────────────────────────────────
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '1007930505834-cpp1veqs8alu56k810qd2mru61keej3j.apps.googleusercontent.com';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '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';
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI ||
  (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}/api/gmail/callback` : 'http://localhost:8080/api/gmail/callback');

// ── Location utilities (module-level, shared by scout run + reclassify) ──────
const STATE_ABBREV: Record<string, string> = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA','colorado':'CO',
  'connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA','hawaii':'HI','idaho':'ID',
  'illinois':'IL','indiana':'IN','iowa':'IA','kansas':'KS','kentucky':'KY','louisiana':'LA',
  'maine':'ME','maryland':'MD','massachusetts':'MA','michigan':'MI','minnesota':'MN',
  'mississippi':'MS','missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV',
  'new hampshire':'NH','new jersey':'NJ','new mexico':'NM','new york':'NY',
  'north carolina':'NC','north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR',
  'pennsylvania':'PA','rhode island':'RI','south carolina':'SC','south dakota':'SD',
  'tennessee':'TN','texas':'TX','utah':'UT','vermont':'VT','virginia':'VA',
  'washington':'WA','west virginia':'WV','wisconsin':'WI','wyoming':'WY',
  'district of columbia':'DC','washington dc':'DC',
};
const ABBREV_TO_STATE: Record<string, string> = Object.fromEntries(
  Object.entries(STATE_ABBREV).map(([k, v]) => [v.toLowerCase(), k])
);
const US_STATE_ABBREVS = /\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\b/;

// International 2-letter country codes that must be treated as territory (not fully-remote)
const INTL_COUNTRY_CODES = /\b(uk|gb|eu|de|fr|es|it|au|nz|sg|hk|jp|kr|cn|nl|be|ch|se|no|dk|ie|pt|pl|cz|at|gr|ro|hu|fi|sk|bg|hr|si|lt|lv|ee|cy|lu|mt)\b/i;

// Single directional words that are too vague for location pattern matching
// (User has "South"/"South East" to describe *themselves*, not as a job location keyword)
const VAGUE_DIRECTIONALS = new Set(['south', 'north', 'east', 'west', 'southern', 'northern', 'eastern', 'western']);

function isRemoteInTerritory(loc: string): boolean {
  if (!/remote/i.test(loc)) return false;
  const stripped = loc
    .replace(/remote/gi, '')
    .replace(/united states?/gi, '')
    .replace(/\b(usa?|100%|fully|full[- ]?time|work from home|wfh|anywhere|nationwide|national|the|of|for|only)\b/gi, '')
    .replace(/[-–,\s().\/;]+/g, ' ')
    .trim();
  // Territory if a 3+ letter word remains, or a US state abbrev, or a 2-letter intl country code
  return /[a-zA-Z]{3,}/.test(stripped) || US_STATE_ABBREVS.test(stripped) || INTL_COUNTRY_CODES.test(stripped);
}

/** Build a regex that matches any of the user's allowed location terms */
function buildLocationAllowPattern(locations: string[]): { pattern: RegExp | null; allowRemote: boolean; allowUnitedStates: boolean } {
  const terms = new Set<string>();
  let allowRemote = false;
  let allowUnitedStates = false;
  for (const loc of locations) {
    const lower = loc.trim().toLowerCase();
    if (lower === 'remote') { allowRemote = true; continue; }
    if (lower === 'united states' || lower === 'usa' || lower === 'us') { allowUnitedStates = true; continue; }
    // Skip single directional words — too vague and cause false positives on city names like "South Salt Lake"
    if (VAGUE_DIRECTIONALS.has(lower)) continue;
    terms.add(lower);
    if (STATE_ABBREV[lower]) terms.add(STATE_ABBREV[lower].toLowerCase());
    if (ABBREV_TO_STATE[lower]) terms.add(ABBREV_TO_STATE[lower]);
  }
  const pattern = terms.size > 0
    ? new RegExp(`\\b(${Array.from(terms).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
    : null;
  return { pattern, allowRemote, allowUnitedStates };
}

/** Returns true if this job's location is acceptable given the user's prefs and work modes */
function checkJobLocation(
  jobLocation: string,
  locations: string[],
  _remoteStrict: boolean,            // kept for backward compat — ignored when allowedWorkModes provided
  allowedWorkModes?: string[],
): boolean {
  if (!locations || locations.length === 0) return true;
  const loc = jobLocation.trim();
  const { pattern, allowRemote, allowUnitedStates } = buildLocationAllowPattern(locations);
  const hasRemote  = /remote/i.test(loc);
  const territory  = isRemoteInTerritory(loc);

  // New mode-based logic
  if (allowedWorkModes && allowedWorkModes.length > 0) {
    const modes = new Set(allowedWorkModes);
    if (hasRemote && !territory) {
      // True remote — check remote_us mode
      return modes.has('remote_us');
    }
    if (hasRemote && territory) {
      // Remote-in-territory — check mode AND territory city must match locations
      if (!modes.has('remote_in_territory')) return false;
      if (locations.length === 0) return true;
      return !!(pattern && pattern.test(loc));
    }
    // "United States" / "US" / blank with no city = nationwide / de-facto remote-eligible
    // ATS boards often use these for roles that are open to any US location.
    // Pass through when remote_us is accepted rather than hard-blocking.
    if (/^(united states|u\.?s\.?a?|nationwide|anywhere in the u\.?s\.?)$/i.test(loc.trim()) || loc.trim() === '' || loc.toLowerCase() === 'unknown') {
      return modes.has('remote_us');
    }
    // Physical on-site job
    if (!modes.has('onsite')) return false;
    if (locations.length === 0) return true;
    if (/^(united states|usa?)$/i.test(loc.trim())) return true;
    return !!(pattern && pattern.test(loc));
  }

  // Legacy fallback (no modes configured — use old remote_strict behavior)
  if (hasRemote && !territory) return allowRemote || allowUnitedStates;
  if (hasRemote && territory) {
    return allowRemote || allowUnitedStates || !!(pattern && pattern.test(loc));
  }
  if (/^(united states|usa?)$/i.test(loc.trim()) && allowUnitedStates) return true;
  return !!(pattern && pattern.test(loc));
}

// ── Database init ─────────────────────────────────────────────────────────
async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS criteria (
      id            SERIAL PRIMARY KEY,
      target_roles  TEXT[]  NOT NULL DEFAULT '{}',
      industries    TEXT[]  NOT NULL DEFAULT '{}',
      min_salary    INT,
      work_type     TEXT    NOT NULL DEFAULT 'any',
      locations     TEXT[]  NOT NULL DEFAULT '{}',
      must_have     TEXT[]  NOT NULL DEFAULT '{}',
      nice_to_have  TEXT[]  NOT NULL DEFAULT '{}',
      avoid         TEXT[]  NOT NULL DEFAULT '{}',
      your_name     TEXT    NOT NULL DEFAULT '',
      your_email    TEXT    NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS companies (
      id          SERIAL PRIMARY KEY,
      name        TEXT    NOT NULL,
      ats_type    TEXT    NOT NULL DEFAULT 'greenhouse',
      ats_slug    TEXT,
      careers_url TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS scout_runs (
      id               SERIAL PRIMARY KEY,
      status           TEXT    NOT NULL DEFAULT 'running',
      companies_scanned INT    NOT NULL DEFAULT 0,
      jobs_found       INT     NOT NULL DEFAULT 0,
      matches_found    INT     NOT NULL DEFAULT 0,
      error            TEXT,
      started_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at     TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id           SERIAL PRIMARY KEY,
      scout_run_id INT     REFERENCES scout_runs(id),
      title        TEXT    NOT NULL,
      company      TEXT    NOT NULL,
      location     TEXT    NOT NULL DEFAULT '',
      salary       TEXT,
      apply_url    TEXT    NOT NULL,
      description  TEXT,
      source       TEXT    NOT NULL DEFAULT '',
      why_good_fit TEXT    NOT NULL DEFAULT '',
      match_score  INT     NOT NULL DEFAULT 0,
      is_hardware  BOOLEAN NOT NULL DEFAULT false,
      status       TEXT    NOT NULL DEFAULT 'new',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS system_prompts (
      id          SERIAL PRIMARY KEY,
      prompt_name TEXT NOT NULL UNIQUE,
      prompt_text TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tailored_docs (
      id           SERIAL PRIMARY KEY,
      job_id       INT     REFERENCES jobs(id),
      resume_text  TEXT    NOT NULL DEFAULT '',
      cover_letter TEXT    NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS gmail_tokens (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL DEFAULT '',
      access_token  TEXT NOT NULL,
      refresh_token TEXT,
      token_type    TEXT NOT NULL DEFAULT 'Bearer',
      expiry_date   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS research_briefs (
      id           SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      brief_json   JSONB NOT NULL,
      saved        BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS job_research (
      id           SERIAL PRIMARY KEY,
      job_id       INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      result_json  JSONB NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS salary_estimates (
      id           SERIAL PRIMARY KEY,
      job_title    TEXT NOT NULL,
      company_name TEXT NOT NULL,
      estimate_json JSONB NOT NULL,
      created_at   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS repvue_cache (
      id           SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      data_json    JSONB NOT NULL,
      created_at   TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS saved_resumes (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      content    TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS career_intel (
      id           SERIAL PRIMARY KEY,
      result_json  JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS job_market_pulse (
      id           SERIAL PRIMARY KEY,
      result_json  JSONB NOT NULL,
      generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS cover_letters (
      id                 SERIAL PRIMARY KEY,
      job_id             INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      cover_letter_text  TEXT NOT NULL,
      research_context   TEXT,
      created_at         TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tailored_resumes (
      id                 SERIAL PRIMARY KEY,
      job_id             INTEGER REFERENCES jobs(id) ON DELETE CASCADE,
      resume_text        TEXT NOT NULL,
      ats_keywords       TEXT[],
      gap_analysis       TEXT,
      ats_research       TEXT,
      created_at         TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS company_momentum (
      id            SERIAL PRIMARY KEY,
      company_name  TEXT NOT NULL,
      momentum_score INT NOT NULL DEFAULT 10,
      signals       JSONB NOT NULL DEFAULT '[]',
      warning       TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await initPositioningDB(pool);
  await initPreIpoDB(pool);
  await initIndustryLeadersDB(pool);
  await initDeepValueDB(pool);

  // Add columns if they don't exist (for existing installs)
  const safeAddColumn = async (table: string, col: string, type: string) => {
    try { await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* ignore */ }
  };
  await safeAddColumn('research_briefs', 'saved', 'BOOLEAN NOT NULL DEFAULT false');
  await safeAddColumn('research_briefs', 'status', "TEXT NOT NULL DEFAULT 'ready'");
  await safeAddColumn('research_briefs', 'error', 'TEXT');
  await safeAddColumn('criteria', 'work_type', "TEXT NOT NULL DEFAULT 'any'");
  await safeAddColumn('criteria', 'remote_strict', 'BOOLEAN NOT NULL DEFAULT true');
  await safeAddColumn('criteria', 'experience_level', "TEXT NOT NULL DEFAULT 'senior'");
  await safeAddColumn('criteria', 'stretch_companies', "TEXT[] NOT NULL DEFAULT '{}'");
  await safeAddColumn('criteria', 'vertical_niches', "TEXT[] NOT NULL DEFAULT '{}'");
  await safeAddColumn('criteria', 'top_target_score', 'INT NOT NULL DEFAULT 65');
  await safeAddColumn('criteria', 'fast_win_score', 'INT NOT NULL DEFAULT 55');
  await safeAddColumn('criteria', 'stretch_score', 'INT NOT NULL DEFAULT 55');
  await safeAddColumn('criteria', 'allowed_work_modes', "TEXT[] NOT NULL DEFAULT '{}'");
  await safeAddColumn('criteria', 'experience_levels', "TEXT[] NOT NULL DEFAULT '{}'");
  await safeAddColumn('criteria', 'min_ote', 'INT');
  await safeAddColumn('saved_resumes', 'content_html', 'TEXT NOT NULL DEFAULT \'\'');
  await safeAddColumn('scout_runs', 'current_stage', "TEXT NOT NULL DEFAULT ''");
  await safeAddColumn('scout_runs', 'jobs_in_pipeline', 'INT NOT NULL DEFAULT 0');
  // Migrate remote_strict → allowed_work_modes for existing rows
  await pool.query(`
    UPDATE criteria
    SET allowed_work_modes = CASE
      WHEN remote_strict = true  THEN ARRAY['remote_us']
      ELSE ARRAY['remote_us','remote_in_territory','onsite']
    END
    WHERE allowed_work_modes = '{}'
  `).catch(() => {});
  // Migrate experience_level (single) → experience_levels (array) for existing rows
  await pool.query(`
    UPDATE criteria
    SET experience_levels = ARRAY[experience_level]
    WHERE experience_levels = '{}' AND experience_level IS NOT NULL AND experience_level <> ''
  `).catch(() => {});
  // Default experience_levels for rows that still have none
  await pool.query(`
    UPDATE criteria SET experience_levels = ARRAY['senior'] WHERE experience_levels = '{}'
  `).catch(() => {});
  // Migrate old 5-level experience values → new 4-level (enterprise/director → strategic)
  await pool.query(`
    UPDATE criteria
    SET experience_levels = ARRAY(
      SELECT DISTINCT CASE WHEN lvl IN ('enterprise','director') THEN 'strategic' ELSE lvl END
      FROM unnest(experience_levels) AS lvl
    )
    WHERE experience_levels && ARRAY['enterprise','director']
  `).catch(() => {});
  await safeAddColumn('jobs', 'saved_at', 'TIMESTAMPTZ');
  await safeAddColumn('scout_runs', 'companies_scanned', 'INT NOT NULL DEFAULT 0');
  await safeAddColumn('criteria', 'company_public', 'BOOLEAN NOT NULL DEFAULT true');
  await safeAddColumn('criteria', 'company_private', 'BOOLEAN NOT NULL DEFAULT true');
  await safeAddColumn('criteria', 'company_revenue_bands', "TEXT[] NOT NULL DEFAULT '{}'");
  await safeAddColumn('criteria', 'company_employee_bands', "TEXT[] NOT NULL DEFAULT '{}'");
  await safeAddColumn('criteria', 'company_funding_stages', "TEXT[] NOT NULL DEFAULT '{}'");
  await safeAddColumn('scout_runs', 'matches_found', 'INT NOT NULL DEFAULT 0');
  await safeAddColumn('jobs', 'source', "TEXT NOT NULL DEFAULT ''");
  await safeAddColumn('criteria', 'proxy_url', "TEXT NOT NULL DEFAULT ''");
  await safeAddColumn('jobs', 'description', 'TEXT');
  await safeAddColumn('jobs', 'date_posted', 'TEXT');
  await safeAddColumn('jobs', 'url_ok', 'BOOLEAN');
  await safeAddColumn('jobs', 'url_checked_at', 'TIMESTAMPTZ');
  await safeAddColumn('jobs', 'canonical_url', 'TEXT');
  await safeAddColumn('jobs', 'canonical_source', 'TEXT');
  await safeAddColumn('jobs', 'original_url', 'TEXT');
  await safeAddColumn('jobs', 'original_title', 'TEXT');
  await safeAddColumn('jobs', 'original_description', 'TEXT');
  await safeAddColumn('jobs', 'link_confidence', 'TEXT');
  await safeAddColumn('jobs', 'was_resolved_by_gemini', 'BOOLEAN NOT NULL DEFAULT false');
  await safeAddColumn('jobs', 'validation_notes', 'TEXT');
  await safeAddColumn('jobs', 'validation_status', "TEXT NOT NULL DEFAULT 'pending'");
  await safeAddColumn('jobs', 'page_type', 'TEXT');
  await safeAddColumn('jobs', 'resolved_title', 'TEXT');
  await safeAddColumn('jobs', 'resolved_description', 'TEXT');
  await safeAddColumn('jobs', 'resolved_location', 'TEXT');
  await safeAddColumn('jobs', 'resolved_metadata_json', 'JSONB');
  await safeAddColumn('jobs', 'metadata_last_verified_at', 'TIMESTAMPTZ');
  await safeAddColumn('jobs', 'is_hardware', 'BOOLEAN NOT NULL DEFAULT false');
  await safeAddColumn('jobs', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await safeAddColumn('jobs', 'status', "TEXT NOT NULL DEFAULT 'new'");
  await safeAddColumn('jobs', 'ai_risk', "TEXT NOT NULL DEFAULT 'unknown'");
  await safeAddColumn('jobs', 'ai_risk_score', 'INT');
  await safeAddColumn('jobs', 'ai_risk_reason', 'TEXT');
  await safeAddColumn('jobs', 'opportunity_tier', "TEXT NOT NULL DEFAULT 'unscored'");
  await safeAddColumn('jobs', 'sub_scores', 'JSONB');
  await safeAddColumn('jobs', 'recovery_match_method', 'TEXT');
  await safeAddColumn('jobs', 'recovery_match_confidence', 'NUMERIC(5,3)');
  await safeAddColumn('companies', 'scan_failures', 'INT NOT NULL DEFAULT 0');
  await safeAddColumn('companies', 'last_scan_error', 'TEXT');
  await safeAddColumn('companies', 'detect_status', "TEXT NOT NULL DEFAULT 'manual'");
  await safeAddColumn('companies', 'ats_types_tried', "TEXT[] NOT NULL DEFAULT '{}'");
  // Gemini discovery columns — added when hybrid pipeline was introduced
  await safeAddColumn('jobs', 'gemini_grounding_metadata', 'JSONB');
  await safeAddColumn('jobs', 'ingestion_confidence', 'FLOAT');
  await safeAddColumn('jobs', 'momentum_warning', 'TEXT');
  await safeAddColumn('jobs', 'user_action', 'TEXT');
  await safeAddColumn('jobs', 'user_action_at', 'TIMESTAMPTZ');
  await safeAddColumn('jobs', 'interview_prep_json', 'TEXT');
  await safeAddColumn('jobs', 'interview_prep_at', 'TIMESTAMPTZ');

  // Index for fast momentum lookups by company name
  try {
    await pool.query('CREATE INDEX IF NOT EXISTS company_momentum_name_idx ON company_momentum (LOWER(company_name))');
  } catch { /* ignore */ }

  // Deduplicate existing jobs — keep the most recent row per apply_url
  try {
    await pool.query(`
      DELETE FROM tailored_docs WHERE job_id IN (
        SELECT id FROM jobs WHERE id NOT IN (
          SELECT MAX(id) FROM jobs GROUP BY apply_url
        )
      )
    `);
    const deduped = await pool.query(`
      DELETE FROM jobs WHERE id NOT IN (
        SELECT MAX(id) FROM jobs GROUP BY apply_url
      )
    `);
    if ((deduped.rowCount ?? 0) > 0) {
      console.log(`Deduplicated: removed ${deduped.rowCount} duplicate jobs`);
    }
  } catch (e) { console.log('Dedup migration:', e); }

  // Add unique index on apply_url to prevent future duplicates
  try {
    await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS jobs_apply_url_uniq ON jobs (apply_url)');
  } catch (e) { console.log('Unique index already exists or failed:', e); }

  // Seed default criteria if none exist
  const { rows } = await pool.query('SELECT id FROM criteria LIMIT 1');
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO criteria (target_roles, industries, min_salary, locations, must_have, nice_to_have, avoid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ['Account Executive', 'Account Manager', 'Sales Executive'],
        ['AI Infrastructure', 'Data Center Hardware', 'Semiconductors', 'Networking Hardware', 'Storage Hardware', 'Optical Networking', 'Edge Computing', 'Power & Cooling Infrastructure', 'Server Hardware', 'Industrial Automation', 'Oilfield Services Technology', 'Energy Technology', 'Clean Energy / Energy Storage', 'Machine Vision', 'Test and Measurement', 'Materials Science / Specialty Chemicals', 'Robotics', 'Servers', 'HPC', 'Compute'],
        130000,
        ['Remote', 'United States', 'South Carolina', 'North Carolina', 'Georgia', 'Florida', 'South East', 'South'],
        ['enterprise sales', 'hardware OR infrastructure OR networking OR storage OR semiconductor OR compute OR optical'],
        ['AI', 'data center', 'GPU', 'NVIDIA', 'industrial automation', 'energy technology', 'machine vision', 'robotics', 'oilfield services', 'energy storage', 'industrial AI', 'oil and gas software', 'utility software', 'grid technology', 'clean energy'],
        ['SDR', 'BDR', 'inbound only', 'SMB only', 'pure SaaS', 'marketing', 'recruiting'],
      ]
    );
  }

  // Seed default cover letter instructions if not set
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ('cover_letter_instructions', $1) ON CONFLICT (key) DO NOTHING`,
    [DEFAULT_COVER_LETTER_INSTRUCTIONS]
  );

  // ── Seed system_prompts table (upsert so new prompt versions always load) ──
  const RESUME_TAILOR_PROMPT = `You are a resume tailoring engine for competitive enterprise sales roles. Your job is to take a master resume and reshape it to match a specific job description — without fabricating anything.

## CORE RULES

1. NEVER invent experience, metrics, titles, companies, or skills the applicant doesn't have
2. NEVER add tools, certifications, or technologies not present in the master resume
3. ONLY reorder, reword, emphasize, or de-emphasize what already exists
4. Write like a human — varied sentence structure, no corporate buzzword chains, no AI-sounding filler
5. Every bullet must contain a concrete metric OR a specific, verifiable action. No fluff bullets like "Drove strategic initiatives to optimize outcomes"
6. Keep it to one page unless the applicant has 10+ years of experience

## WHAT YOU RECEIVE

- The applicant's master resume (full work history, all bullets, all details)
- A job description for the target role
- Company research notes (business context, why they're hiring, competitive landscape)

## WHAT YOU DO

### Step 1: Analyze the Job Description
Identify the top 5 things this employer actually cares about. Look at:
- What's mentioned first and most often in the JD
- Required vs. preferred qualifications
- The seniority signals (quota size, territory scope, deal complexity)
- Industry or vertical focus
- Tech stack, tools, or partner ecosystems mentioned

### Step 2: Map the Applicant's Experience
For each of those top 5 priorities, find the closest matching proof point in the master resume. If there's no match, skip it — do not fabricate.

### Step 3: Rewrite the Resume
- Put the most relevant role first if it's not already (reverse chronological is flexible when the most relevant role isn't the most recent)
- Rewrite bullet points to lead with the language and priorities from the JD — but in the applicant's natural voice, not copy-pasted JD jargon
- If the JD emphasizes "net-new acquisition" and the applicant's bullet says "managed full-cycle sales," rewrite it as "Drove net-new customer acquisition through full-cycle enterprise sales"
- Cut or condense bullets that don't map to anything in the JD
- Expand bullets that directly match the JD's top priorities
- Make sure the first bullet under each role is the strongest, most relevant proof point

### Step 4: Skills / Tools Section
Only include skills, tools, and platforms that appear in BOTH the master resume AND the job description. Don't pad with generic skills.

## WRITING STYLE

- Short, punchy sentences. Active voice only.
- Lead every bullet with a strong verb: Built, Closed, Grew, Drove, Launched, Negotiated, Expanded
- Numbers first when possible: "$2.8M in revenue" not "revenue of $2.8M"
- No buzzwords: "synergy," "leverage," "utilize," "spearhead," "cutting-edge," "best-in-class," "paradigm"
- No filler phrases: "Responsible for," "Tasked with," "Helped to," "Played a key role in"
- Vary your sentence patterns. If three bullets in a row start with "Drove," rewrite two of them.
- Read it out loud — if it sounds like a LinkedIn post written by AI, rewrite it

## OUTPUT FORMAT

Return ONLY the tailored resume text. No commentary, no explanations, no "Here's your tailored resume." Just the resume content, formatted cleanly with the applicant's name, contact info, and each role with its bullets.`;

  const COVER_LETTER_WRITER_PROMPT = `You are a cover letter writer for competitive enterprise sales roles. You write cover letters that function like elite cold outreach emails — because the skill being demonstrated IS the skill being hired for.

## THE PHILOSOPHY

A cover letter for a sales role is a live audition. The hiring manager is evaluating whether you can:
- Research a prospect (the company)
- Identify their business problem (why they're hiring)
- Position a solution (the applicant) concisely
- Ask for a next step without being pushy

If the cover letter reads like a highlight reel of the resume, it fails. The hiring manager already has the resume. The cover letter must do something the resume can't: show the applicant understands the COMPANY'S situation and can articulate why they're the right fit in under 30 seconds of reading.

## WHAT YOU RECEIVE

- The applicant's master resume
- The tailored resume (already matched to this role)
- The job description
- Company research notes (business context, why they're hiring, competitive landscape)

## THE STRUCTURE (follow this exactly)

### Line 1: Salutation
"Dear [Company Name] Hiring Team," — unless a specific hiring manager name is provided, in which case use "Dear [First Name] [Last Name],"

### Paragraph 1: The Opening (2-3 sentences)
State what role you're reaching out about. Then immediately frame the COMPANY'S situation — not the applicant's background. Use the company research to say something specific about their business moment: expansion into new markets, competitive pressure, product launch, go-to-market shift. This shows you did your homework, just like you would on a sales call.

DO NOT open with:
- "I am excited to apply for..."
- "I am writing to express my interest..."
- "With X years of experience in..."
- "I believe I would be a great fit..."
- Any sentence that starts with "I" followed by an emotion

DO open with:
- The company's situation, challenge, or opportunity
- A specific observation that shows research
- Then pivot to "That requires [type of seller] — which is what I've done for [X] years"

### Paragraph 2: Transition + Proof Points (1 sentence + 3 bullets)
One transition sentence: "A few proof points:" or "Here's what that's looked like:" — then three bullets.

Each bullet must:
- Be one line (two max)
- Contain a specific number ($, %, count)
- Name the company where it happened
- Connect to something the JD or company research says matters

Pick the THREE most relevant proof points from the tailored resume. Not the three most impressive — the three most RELEVANT to what this company needs right now.

### Paragraph 3: The Close (2 sentences max)
State that you have a specific perspective on how you'd approach their territory/market/problem. Ask for a short call (15-20 minutes). Do not grovel.

DO NOT close with:
- "I would welcome the opportunity to discuss..."
- "I look forward to hearing from you..."
- "Thank you for your time and consideration..."
- "I am confident that I would be a valuable addition..."

DO close with:
- Something specific: "I have a perspective on how I'd approach the [region/vertical/segment]"
- A low-commitment ask: "Happy to share it over a 20-minute call"
- That's it. No begging.

### Sign-off
"Best,"
[Full Name]

## WRITING RULES

1. Total length: 150-200 words. Not a word more. This is a cold email, not an essay.
2. No buzzwords. No "synergy," "leverage," "passionate," "thrilled," "excited."
3. No filler. Every sentence must either (a) show you understand their business or (b) prove you can do the job.
4. Write at an 8th grade reading level. Short words. Short sentences. If a sentence has a comma, ask yourself if it should be two sentences.
5. Sound like a real person wrote this at 10pm after doing research on the company, not like an AI generated it from a template.
6. Vary sentence length. Mix short punchy sentences with one longer one. Monotone rhythm = AI-sounding.
7. Never use the phrase "I am confident" — confident people don't announce their confidence.
8. Never start three sentences in a row with "I."
9. The word "synergy" appears zero times. The word "leverage" appears zero times. The word "utilize" appears zero times. The word "spearhead" appears zero times.
10. Read it out loud. If it sounds like every other cover letter, rewrite it. If it sounds like something you'd actually send to a VP of Sales you found on LinkedIn, it's right.

## AI DETECTION AVOIDANCE

To sound human and pass AI writing detection:
- Use contractions naturally: "I've" not "I have," "that's" not "that is," "don't" not "do not"
- Include one slightly informal phrase per letter — "Happy to connect" or "Here's what that looked like" — the way a real salesperson writes
- Avoid perfect parallel structure in your three bullets. Real humans don't write three grammatically identical sentences in a row.
- Vary paragraph length. Not every paragraph should be 2-3 sentences.
- Use an em dash (—) or a colon occasionally instead of always using periods
- Don't start the letter and end the letter with the same energy. Start direct, end warm. Or start observational, end confident. Humans shift tone slightly across a piece of writing.

## OUTPUT FORMAT

Return ONLY the cover letter text. No commentary, no explanations, no "Here's your cover letter." Just the letter itself, ready to paste into a document or email.`;

  await pool.query(
    `INSERT INTO system_prompts (prompt_name, prompt_text, updated_at)
     VALUES ('resume_tailor', $1, NOW()), ('cover_letter_writer', $2, NOW())
     ON CONFLICT (prompt_name) DO UPDATE SET prompt_text = EXCLUDED.prompt_text, updated_at = NOW()`,
    [RESUME_TAILOR_PROMPT, COVER_LETTER_WRITER_PROMPT]
  );

  // Seed companies if none exist
  const { rows: coRows } = await pool.query('SELECT id FROM companies LIMIT 1');
  if (coRows.length === 0) {
    const greenhouse: [string, string][] = [
      ['Pure Storage', 'purestorage'],
      ['CoreWeave', 'coreweave'],
      ['Samsara', 'samsara'],
      ['Databricks', 'databricks'],
      ['Iron Mountain', 'ironmountainsolutions'],
      ['Cohesity', 'cohesity'],
      ['Bentley Systems', 'bentleysystems'],
      ['Crane NXT', 'cranenxt'],
      ['Scale AI', 'scaleai'],
      ['Enverus', 'enverus'],
      ['Cognite', 'cognite'],
      ['Urbint', 'urbint'],
      ['EnergyHub', 'energyhub'],
    ];
    for (const [name, slug] of greenhouse) {
      await pool.query(
        `INSERT INTO companies (name, ats_type, ats_slug) VALUES ($1, 'greenhouse', $2)`,
        [name, slug]
      );
    }

    const lever: [string, string][] = [
      ['Extreme Networks', 'extremenetworks'],
    ];
    for (const [name, slug] of lever) {
      await pool.query(
        `INSERT INTO companies (name, ats_type, ats_slug) VALUES ($1, 'lever', $2)`,
        [name, slug]
      );
    }

    const workday: [string, string, string | null][] = [
      ['NVIDIA', 'nvidia.wd5.myworkdayjobs.com', 'NVIDIAExternalCareerSite'],
      ['Broadcom', 'broadcom.wd1.myworkdayjobs.com', 'External_Career'],
      ['Lumentum', 'lumentum.wd5.myworkdayjobs.com', 'LITE'],
      ['Marvell Technology', 'marvell.wd1.myworkdayjobs.com', 'MarvellCareers'],
      ['Calix', 'calix.wd1.myworkdayjobs.com', 'External'],
      ['Dell Technologies', 'dell.wd1.myworkdayjobs.com', 'External'],
      ['HPE', 'hpe.wd5.myworkdayjobs.com', 'Jobsathpe'],
      ['Cisco', 'cisco.wd5.myworkdayjobs.com', 'Cisco_Careers'],
      ['Micron', 'micron.wd1.myworkdayjobs.com', 'External'],
      ['Equinix', 'equinix.wd1.myworkdayjobs.com', 'External'],
      ['F5', 'ffive.wd5.myworkdayjobs.com', 'f5jobs'],
      ['Seagate', 'seagate.wd1.myworkdayjobs.com', 'EXT'],
      ['Rockwell Automation', 'rockwellautomation.wd1.myworkdayjobs.com', 'External_Rockwell_Automation'],
      ['Baker Hughes', 'bakerhughes.wd5.myworkdayjobs.com', 'BakerHughes'],
      ['Entegris', 'entegris.wd1.myworkdayjobs.com', 'EntegrisCareers'],
      ['Cognex', 'cognex.wd1.myworkdayjobs.com', 'External_Career_Site'],
      ['Bloom Energy', 'bloomenergy.wd1.myworkdayjobs.com', 'BloomEnergyCareers'],
      ['3M', '3m.wd1.myworkdayjobs.com', 'Search'],
      ['Honeywell', 'honeywell.wd5.myworkdayjobs.com', 'Honeywell'],
      ['Cadence Design Systems', 'cadence.wd1.myworkdayjobs.com', 'External_Careers'],
      ['Xylem', 'xylem.wd1.myworkdayjobs.com', 'Xylem'],
      ['Trimble', 'trimble.wd1.myworkdayjobs.com', 'TrimbleCareers'],
      ['Aspen Technology', 'aspentech.wd1.myworkdayjobs.com', 'AspenTech'],
    ];
    for (const [name, domain, careerSite] of workday) {
      await pool.query(
        `INSERT INTO companies (name, ats_type, careers_url, ats_slug) VALUES ($1, 'workday', $2, $3)`,
        [name, domain, careerSite]
      );
    }

    const plain: [string, string][] = [
      ['Nutanix', 'https://careers.nutanix.com/'],
      ['Palo Alto Networks', 'https://jobs.paloaltonetworks.com/en'],
      ['Arista Networks', 'https://www.arista.com/en/careers'],
      ['Coherent Corp', 'https://www.coherent.com/company/careers'],
      ['CommScope', 'https://jobs.commscope.com/'],
      ['NetApp', 'https://careers.netapp.com/'],
      ['Veeva Systems', 'https://careers.veeva.com/'],
      ['AMD', 'https://careers.amd.com/'],
      ['Vertiv', 'https://www.vertiv.com/en-us/about/careers/'],
      ['Juniper Networks', 'https://jobs.juniper.net'],
      ['Eaton', 'https://jobs.eaton.com'],
      ['Keysight Technologies', 'https://careers.keysight.com'],
      ['Schneider Electric', 'https://careers.schneiderelectric.com'],
      ['Supermicro', 'https://www.supermicro.com/en/about/jobs'],
      ['Fortinet', 'https://www.fortinet.com/corporate/careers/careers-search'],
      ['Ciena', 'https://www.ciena.com/careers'],
      ['Infinera', 'https://www.infinera.com/company/careers'],
      ['Viavi Solutions', 'https://www.viavisolutions.com/en-us/careers'],
      ['Western Digital', 'https://jobs.westerndigital.com'],
      ['Lambda Labs', 'https://lambdalabs.com/careers'],
      ['Groq', 'https://groq.com/careers'],
      ['Cerebras', 'https://cerebras.ai/careers'],
      ['Tenstorrent', 'https://tenstorrent.com/careers'],
      ['Digital Realty', 'https://www.digitalrealty.com/careers'],
      ['VAST Data', 'https://www.vastdata.com/careers'],
      ['Weka', 'https://www.weka.io/company/careers'],
      ['Teradyne', 'https://jobs.teradyne.com'],
      ['Zebra Technologies', 'https://careers.zebra.com'],
      ['Halliburton', 'https://www.halliburton.com/en/careers'],
      ['Schlumberger', 'https://www.slb.com/careers'],
      ['ABB', 'https://careers.abb/global/en/jobs'],
      ['Siemens', 'https://jobs.siemens.com/careers'],
      ['Dow', 'https://www.dow.com/en-us/careers'],
      ['PPG Industries', 'https://careers.ppg.com'],
      ['Axalta', 'https://careers.axalta.com'],
      ['Enphase Energy', 'https://www.enphase.com/careers'],
      ['First Solar', 'https://www.firstsolar.com/careers'],
      ['Ameresco', 'https://www.ameresco.com/careers'],
      ['Keyence', 'https://www.keyence.com/company/jobs'],
      ['Fluence', 'https://fluenceenergy.com/energy-storage-careers/'],
      ['Emerson Electric', 'https://www.emerson.com/en-us/careers/career-opportunities'],
      ['AVEVA', 'https://www.aveva.com/en/about/careers'],
      ['Itron', 'https://www.itron.com/na/about/careers'],
      ['IDEX Corporation', 'https://www.idexcorp.com/careers'],
      ['Roper Technologies', 'https://www.ropertechnologies.com/careers'],
      ['AWS', 'https://aws.amazon.com/careers'],
      ['Google Cloud', 'https://careers.google.com'],
    ];
    for (const [name, url] of plain) {
      await pool.query(
        `INSERT INTO companies (name, ats_type, careers_url) VALUES ($1, 'plain', $2)`,
        [name, url]
      );
    }
  }

  // ── Migrate: ensure all target companies exist, remove retired ones ──
  const targetCompanies: { name: string; ats_type: string; ats_slug?: string; careers_url?: string }[] = [
    // Greenhouse (verified slugs)
    { name: 'Pure Storage', ats_type: 'greenhouse', ats_slug: 'purestorage' },
    { name: 'CoreWeave', ats_type: 'greenhouse', ats_slug: 'coreweave' },
    { name: 'Samsara', ats_type: 'greenhouse', ats_slug: 'samsara' },
    { name: 'Databricks', ats_type: 'greenhouse', ats_slug: 'databricks' },
    { name: 'Iron Mountain', ats_type: 'greenhouse', ats_slug: 'ironmountainsolutions' },
    { name: 'Cohesity', ats_type: 'greenhouse', ats_slug: 'cohesity' },
    { name: 'Bentley Systems', ats_type: 'greenhouse', ats_slug: 'bentleysystems' },
    { name: 'Crane NXT', ats_type: 'greenhouse', ats_slug: 'cranenxt' },
    { name: 'Scale AI', ats_type: 'greenhouse', ats_slug: 'scaleai' },
    { name: 'Enverus', ats_type: 'greenhouse', ats_slug: 'enverus' },
    { name: 'Cognite', ats_type: 'greenhouse', ats_slug: 'cognite' },
    { name: 'Urbint', ats_type: 'greenhouse', ats_slug: 'urbint' },
    { name: 'EnergyHub', ats_type: 'greenhouse', ats_slug: 'energyhub' },
    // Lever
    { name: 'Extreme Networks', ats_type: 'lever', ats_slug: 'extremenetworks' },
    // Workday (verified domains and careerSite names)
    { name: 'NVIDIA', ats_type: 'workday', careers_url: 'nvidia.wd5.myworkdayjobs.com', ats_slug: 'NVIDIAExternalCareerSite' },
    { name: 'Broadcom', ats_type: 'workday', careers_url: 'broadcom.wd1.myworkdayjobs.com', ats_slug: 'External_Career' },
    { name: 'Lumentum', ats_type: 'workday', careers_url: 'lumentum.wd5.myworkdayjobs.com', ats_slug: 'LITE' },
    { name: 'Marvell Technology', ats_type: 'workday', careers_url: 'marvell.wd1.myworkdayjobs.com', ats_slug: 'MarvellCareers' },
    { name: 'Calix', ats_type: 'workday', careers_url: 'calix.wd1.myworkdayjobs.com', ats_slug: 'External' },
    { name: 'Dell Technologies', ats_type: 'workday', careers_url: 'dell.wd1.myworkdayjobs.com', ats_slug: 'External' },
    { name: 'HPE', ats_type: 'workday', careers_url: 'hpe.wd5.myworkdayjobs.com', ats_slug: 'Jobsathpe' },
    { name: 'Cisco', ats_type: 'workday', careers_url: 'cisco.wd5.myworkdayjobs.com', ats_slug: 'Cisco_Careers' },
    { name: 'Micron', ats_type: 'workday', careers_url: 'micron.wd1.myworkdayjobs.com', ats_slug: 'External' },
    { name: 'Equinix', ats_type: 'workday', careers_url: 'equinix.wd1.myworkdayjobs.com', ats_slug: 'External' },
    { name: 'F5', ats_type: 'workday', careers_url: 'ffive.wd5.myworkdayjobs.com', ats_slug: 'f5jobs' },
    { name: 'Seagate', ats_type: 'workday', careers_url: 'seagate.wd1.myworkdayjobs.com', ats_slug: 'EXT' },
    { name: 'Rockwell Automation', ats_type: 'workday', careers_url: 'rockwellautomation.wd1.myworkdayjobs.com', ats_slug: 'External_Rockwell_Automation' },
    { name: 'Baker Hughes', ats_type: 'workday', careers_url: 'bakerhughes.wd5.myworkdayjobs.com', ats_slug: 'BakerHughes' },
    { name: 'Entegris', ats_type: 'workday', careers_url: 'entegris.wd1.myworkdayjobs.com', ats_slug: 'EntegrisCareers' },
    { name: 'Cognex', ats_type: 'workday', careers_url: 'cognex.wd1.myworkdayjobs.com', ats_slug: 'External_Career_Site' },
    { name: 'Bloom Energy', ats_type: 'workday', careers_url: 'bloomenergy.wd1.myworkdayjobs.com', ats_slug: 'BloomEnergyCareers' },
    { name: '3M', ats_type: 'workday', careers_url: '3m.wd1.myworkdayjobs.com', ats_slug: 'Search' },
    { name: 'Honeywell', ats_type: 'workday', careers_url: 'honeywell.wd5.myworkdayjobs.com', ats_slug: 'Honeywell' },
    { name: 'Cadence Design Systems', ats_type: 'workday', careers_url: 'cadence.wd1.myworkdayjobs.com', ats_slug: 'External_Careers' },
    { name: 'Xylem', ats_type: 'workday', careers_url: 'xylem.wd1.myworkdayjobs.com', ats_slug: 'Xylem' },
    { name: 'Trimble', ats_type: 'workday', careers_url: 'trimble.wd1.myworkdayjobs.com', ats_slug: 'TrimbleCareers' },
    { name: 'Aspen Technology', ats_type: 'workday', careers_url: 'aspentech.wd1.myworkdayjobs.com', ats_slug: 'AspenTech' },
    // Plain / Other (includes companies moved from wrong ATS types)
    { name: 'Nutanix', ats_type: 'plain', careers_url: 'https://careers.nutanix.com/' },
    { name: 'Palo Alto Networks', ats_type: 'plain', careers_url: 'https://jobs.paloaltonetworks.com/en' },
    { name: 'Arista Networks', ats_type: 'plain', careers_url: 'https://www.arista.com/en/careers' },
    { name: 'Coherent Corp', ats_type: 'plain', careers_url: 'https://www.coherent.com/company/careers' },
    { name: 'CommScope', ats_type: 'plain', careers_url: 'https://jobs.commscope.com/' },
    { name: 'NetApp', ats_type: 'plain', careers_url: 'https://careers.netapp.com/' },
    { name: 'Veeva Systems', ats_type: 'plain', careers_url: 'https://careers.veeva.com/' },
    { name: 'AMD', ats_type: 'plain', careers_url: 'https://careers.amd.com/' },
    { name: 'Vertiv', ats_type: 'plain', careers_url: 'https://www.vertiv.com/en-us/about/careers/' },
    { name: 'Juniper Networks', ats_type: 'plain', careers_url: 'https://jobs.juniper.net' },
    { name: 'Eaton', ats_type: 'plain', careers_url: 'https://jobs.eaton.com' },
    { name: 'Keysight Technologies', ats_type: 'plain', careers_url: 'https://careers.keysight.com' },
    { name: 'Schneider Electric', ats_type: 'plain', careers_url: 'https://careers.schneiderelectric.com' },
    { name: 'Supermicro', ats_type: 'plain', careers_url: 'https://www.supermicro.com/en/about/jobs' },
    { name: 'Fortinet', ats_type: 'plain', careers_url: 'https://www.fortinet.com/corporate/careers/careers-search' },
    { name: 'Ciena', ats_type: 'plain', careers_url: 'https://www.ciena.com/careers' },
    { name: 'Infinera', ats_type: 'plain', careers_url: 'https://www.infinera.com/company/careers' },
    { name: 'Viavi Solutions', ats_type: 'plain', careers_url: 'https://www.viavisolutions.com/en-us/careers' },
    { name: 'Western Digital', ats_type: 'plain', careers_url: 'https://jobs.westerndigital.com' },
    { name: 'Lambda Labs', ats_type: 'plain', careers_url: 'https://lambdalabs.com/careers' },
    { name: 'Groq', ats_type: 'plain', careers_url: 'https://groq.com/careers' },
    { name: 'Cerebras', ats_type: 'plain', careers_url: 'https://cerebras.ai/careers' },
    { name: 'Tenstorrent', ats_type: 'plain', careers_url: 'https://tenstorrent.com/careers' },
    { name: 'Digital Realty', ats_type: 'plain', careers_url: 'https://www.digitalrealty.com/careers' },
    { name: 'One Stop Systems', ats_type: 'plain', careers_url: 'https://onestopsystems.com/pages/sales-account-manager' },
    { name: 'VAST Data', ats_type: 'plain', careers_url: 'https://www.vastdata.com/careers' },
    { name: 'Weka', ats_type: 'plain', careers_url: 'https://www.weka.io/company/careers' },
    { name: 'Teradyne', ats_type: 'plain', careers_url: 'https://jobs.teradyne.com' },
    { name: 'Zebra Technologies', ats_type: 'plain', careers_url: 'https://careers.zebra.com' },
    { name: 'Halliburton', ats_type: 'plain', careers_url: 'https://www.halliburton.com/en/careers' },
    { name: 'Schlumberger', ats_type: 'plain', careers_url: 'https://www.slb.com/careers' },
    { name: 'ABB', ats_type: 'plain', careers_url: 'https://careers.abb/global/en/jobs' },
    { name: 'Siemens', ats_type: 'plain', careers_url: 'https://jobs.siemens.com/careers' },
    { name: 'Dow', ats_type: 'plain', careers_url: 'https://www.dow.com/en-us/careers' },
    { name: 'PPG Industries', ats_type: 'plain', careers_url: 'https://careers.ppg.com' },
    { name: 'Axalta', ats_type: 'plain', careers_url: 'https://careers.axalta.com' },
    { name: 'Enphase Energy', ats_type: 'plain', careers_url: 'https://www.enphase.com/careers' },
    { name: 'First Solar', ats_type: 'plain', careers_url: 'https://www.firstsolar.com/careers' },
    { name: 'Ameresco', ats_type: 'plain', careers_url: 'https://www.ameresco.com/careers' },
    { name: 'Keyence', ats_type: 'plain', careers_url: 'https://www.keyence.com/company/jobs' },
    { name: 'Fluence', ats_type: 'plain', careers_url: 'https://fluenceenergy.com/energy-storage-careers/' },
    { name: 'Emerson Electric', ats_type: 'plain', careers_url: 'https://www.emerson.com/en-us/careers/career-opportunities' },
    { name: 'AVEVA', ats_type: 'plain', careers_url: 'https://www.aveva.com/en/about/careers' },
    { name: 'Itron', ats_type: 'plain', careers_url: 'https://www.itron.com/na/about/careers' },
    { name: 'IDEX Corporation', ats_type: 'plain', careers_url: 'https://www.idexcorp.com/careers' },
    { name: 'Roper Technologies', ats_type: 'plain', careers_url: 'https://www.ropertechnologies.com/careers' },
    { name: 'AWS', ats_type: 'plain', careers_url: 'https://aws.amazon.com/careers' },
    { name: 'Google Cloud', ats_type: 'plain', careers_url: 'https://careers.google.com' },
  ];

  // Remove retired companies
  const retiredNames = ['Anritsu', 'Datadog', 'Zscaler', 'CrowdStrike', 'Rubrik', 'Veeam', 'Zerto', 'Commvault', 'Snowflake', 'Dynatrace'];
  for (const name of retiredNames) {
    await pool.query('DELETE FROM companies WHERE LOWER(name) = LOWER($1)', [name]);
  }

  // Add any missing companies (match on lowercase name to avoid duplicates)
  const { rows: existingCos } = await pool.query('SELECT LOWER(name) as lname FROM companies');
  const existingSet = new Set(existingCos.map((r: { lname: string }) => r.lname));
  for (const co of targetCompanies) {
    if (!existingSet.has(co.name.toLowerCase())) {
      await pool.query(
        `INSERT INTO companies (name, ats_type, ats_slug, careers_url) VALUES ($1, $2, $3, $4)`,
        [co.name, co.ats_type, co.ats_slug ?? null, co.careers_url ?? null]
      );
      console.log(`Added company: ${co.name}`);
    }
  }

  // Fix existing entries that changed ATS type or URL
  const fixes: { name: string; ats_type: string; careers_url: string | null; ats_slug: string | null }[] = [
    // Companies moved FROM Greenhouse TO Workday
    { name: 'NVIDIA', ats_type: 'workday', careers_url: 'nvidia.wd5.myworkdayjobs.com', ats_slug: 'NVIDIAExternalCareerSite' },
    { name: 'Broadcom', ats_type: 'workday', careers_url: 'broadcom.wd1.myworkdayjobs.com', ats_slug: 'External_Career' },
    { name: 'Lumentum', ats_type: 'workday', careers_url: 'lumentum.wd5.myworkdayjobs.com', ats_slug: 'LITE' },
    { name: 'Marvell Technology', ats_type: 'workday', careers_url: 'marvell.wd1.myworkdayjobs.com', ats_slug: 'MarvellCareers' },
    { name: 'Calix', ats_type: 'workday', careers_url: 'calix.wd1.myworkdayjobs.com', ats_slug: 'External' },
    // Companies moved FROM Greenhouse TO Plain
    { name: 'Nutanix', ats_type: 'plain', careers_url: 'https://careers.nutanix.com/', ats_slug: null },
    { name: 'Palo Alto Networks', ats_type: 'plain', careers_url: 'https://jobs.paloaltonetworks.com/en', ats_slug: null },
    { name: 'Arista Networks', ats_type: 'plain', careers_url: 'https://www.arista.com/en/careers', ats_slug: null },
    { name: 'Coherent Corp', ats_type: 'plain', careers_url: 'https://www.coherent.com/company/careers', ats_slug: null },
    { name: 'CommScope', ats_type: 'plain', careers_url: 'https://jobs.commscope.com/', ats_slug: null },
    { name: 'NetApp', ats_type: 'plain', careers_url: 'https://careers.netapp.com/', ats_slug: null },
    { name: 'Veeva Systems', ats_type: 'plain', careers_url: 'https://careers.veeva.com/', ats_slug: null },
    // Companies moved FROM Workday TO Plain (wrong ATS)
    { name: 'AMD', ats_type: 'plain', careers_url: 'https://careers.amd.com/', ats_slug: null },
    { name: 'Vertiv', ats_type: 'plain', careers_url: 'https://www.vertiv.com/en-us/about/careers/', ats_slug: null },
    // Companies moved FROM Workday TO Lever
    { name: 'Extreme Networks', ats_type: 'lever', careers_url: null, ats_slug: 'extremenetworks' },
    // Greenhouse slug fix
    { name: 'Iron Mountain', ats_type: 'greenhouse', careers_url: null, ats_slug: 'ironmountainsolutions' },
    // Workday careerSite fixes
    { name: 'Dell Technologies', ats_type: 'workday', careers_url: 'dell.wd1.myworkdayjobs.com', ats_slug: 'External' },
    { name: 'HPE', ats_type: 'workday', careers_url: 'hpe.wd5.myworkdayjobs.com', ats_slug: 'Jobsathpe' },
    { name: 'Cisco', ats_type: 'workday', careers_url: 'cisco.wd5.myworkdayjobs.com', ats_slug: 'Cisco_Careers' },
    { name: 'Micron', ats_type: 'workday', careers_url: 'micron.wd1.myworkdayjobs.com', ats_slug: 'External' },
    { name: 'Equinix', ats_type: 'workday', careers_url: 'equinix.wd1.myworkdayjobs.com', ats_slug: 'External' },
    { name: 'F5', ats_type: 'workday', careers_url: 'ffive.wd5.myworkdayjobs.com', ats_slug: 'f5jobs' },
    { name: 'Seagate', ats_type: 'workday', careers_url: 'seagate.wd1.myworkdayjobs.com', ats_slug: 'EXT' },
    { name: 'Honeywell', ats_type: 'workday', careers_url: 'honeywell.wd5.myworkdayjobs.com', ats_slug: 'Honeywell' },
    { name: 'Cadence Design Systems', ats_type: 'workday', careers_url: 'cadence.wd1.myworkdayjobs.com', ats_slug: 'External_Careers' },
    // Lever removed (don't actually use Lever — already have plain entries)
    { name: 'VAST Data', ats_type: 'plain', careers_url: 'https://www.vastdata.com/careers', ats_slug: null },
    { name: 'Weka', ats_type: 'plain', careers_url: 'https://www.weka.io/company/careers', ats_slug: null },
    // Misc fixes
    { name: 'ABB', ats_type: 'plain', careers_url: 'https://careers.abb/global/en/jobs', ats_slug: null },
    { name: 'Fluence', ats_type: 'plain', careers_url: 'https://fluenceenergy.com/energy-storage-careers/', ats_slug: null },
  ];
  for (const fix of fixes) {
    await pool.query(
      `UPDATE companies SET ats_type=$1, careers_url=$2, ats_slug=$3 WHERE LOWER(name) = LOWER($4)`,
      [fix.ats_type, fix.careers_url, fix.ats_slug, fix.name]
    );
  }

  // Mark any stale running records as failed
  await pool.query(
    "UPDATE scout_runs SET status='failed', error='Server restarted — run was abandoned', completed_at=NOW() WHERE status='running'"
  );
}

// ── API Routes ────────────────────────────────────────────────────────────

// Criteria
app.get('/api/criteria', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    res.json(rows[0] ?? {});
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put('/api/criteria', async (req: Request, res: Response) => {
  try {
    const {
      target_roles, industries, min_salary, min_ote, work_type, locations, must_have, nice_to_have, avoid,
      your_name, your_email, remote_strict,
      experience_level, stretch_companies, vertical_niches, top_target_score, fast_win_score, stretch_score,
      allowed_work_modes, experience_levels, proxy_url,
      company_public, company_private, company_revenue_bands, company_employee_bands, company_funding_stages,
    } = req.body;
    const { rows: existing } = await pool.query('SELECT id FROM criteria LIMIT 1');
    const params = [
      target_roles ?? [], industries ?? [], min_salary ?? null, work_type ?? 'any', locations ?? [],
      must_have ?? [], nice_to_have ?? [], avoid ?? [], your_name ?? '', your_email ?? '',
      remote_strict !== false,
      experience_level ?? 'senior',
      stretch_companies ?? [],
      vertical_niches ?? [],
      top_target_score ?? 65,
      fast_win_score ?? 55,
      stretch_score ?? 55,
      allowed_work_modes ?? ['remote_us'],
      experience_levels && experience_levels.length > 0 ? experience_levels : ['senior'],
      proxy_url ?? '',
      min_ote ?? null,
      company_public !== false,
      company_private !== false,
      company_revenue_bands ?? [],
      company_employee_bands ?? [],
      company_funding_stages ?? [],
    ];
    let savedRow: Record<string, unknown>;
    if (existing.length === 0) {
      const { rows } = await pool.query(
        `INSERT INTO criteria (target_roles, industries, min_salary, work_type, locations, must_have, nice_to_have, avoid, your_name, your_email, remote_strict, experience_level, stretch_companies, vertical_niches, top_target_score, fast_win_score, stretch_score, allowed_work_modes, experience_levels, proxy_url, min_ote, company_public, company_private, company_revenue_bands, company_employee_bands, company_funding_stages)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`, params
      );
      savedRow = rows[0];
    } else {
      const { rows } = await pool.query(
        `UPDATE criteria SET target_roles=$1, industries=$2, min_salary=$3, work_type=$4, locations=$5,
         must_have=$6, nice_to_have=$7, avoid=$8, your_name=$9, your_email=$10, remote_strict=$11,
         experience_level=$12, stretch_companies=$13, vertical_niches=$14, top_target_score=$15, fast_win_score=$16, stretch_score=$17,
         allowed_work_modes=$18, experience_levels=$19, proxy_url=$20, min_ote=$21,
         company_public=$22, company_private=$23, company_revenue_bands=$24, company_employee_bands=$25, company_funding_stages=$26
         WHERE id=$27 RETURNING *`, [...params, existing[0].id]
      );
      savedRow = rows[0];
    }
    res.json(savedRow);
    // Re-classify existing jobs using the new settings (no Claude — uses stored sub_scores)
    reclassifyJobsLocally()
      .then(n => { if (n > 0) console.log(`Settings saved → reclassified ${n} job(s) using new criteria`); })
      .catch(e => console.warn('Post-save reclassify error:', e));
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Companies
app.get('/api/companies', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM companies ORDER BY name');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/companies', async (req: Request, res: Response) => {
  try {
    const { name, ats_type, ats_slug, careers_url } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO companies (name, ats_type, ats_slug, careers_url) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, ats_type ?? 'greenhouse', ats_slug ?? null, careers_url ?? null]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/companies/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM companies WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── ATS auto-detection ─────────────────────────────────────────────────────
// Returns candidate ATS configs from Claude, then validates each by
// actually probing the ATS API endpoint.
async function detectAtsWithClaude(companyName: string, websiteHint?: string): Promise<{
  ats_type: string; ats_slug: string | null; careers_url: string | null; confidence: string;
}[]> {
  const Anthropic = (await import('@anthropic-ai/sdk')).default;
  const anthropic = new Anthropic();

  const websiteLine = websiteHint ? `\nCompany website hint: ${websiteHint}` : '';

  const prompt = `You are an expert at identifying what Applicant Tracking System (ATS) companies use.

Company: "${companyName}"${websiteLine}

Identify the top 3 most likely ATS configurations for this company. Return ONLY a JSON array:

[
  {
    "ats_type": "greenhouse",
    "ats_slug": "companyslug",
    "careers_url": null,
    "confidence": "high"
  },
  ...
]

ATS types and their ats_slug/careers_url patterns:
- "greenhouse": ats_slug used in https://boards-api.greenhouse.io/v1/boards/ATS_SLUG/jobs — typically lowercase company name, no spaces (e.g. "purestorage", "databricks", "samsara")
- "lever": ats_slug used in https://api.lever.co/v0/postings/ATS_SLUG — same pattern (e.g. "netflix", "stripe", "openai")
- "workday": careers_url = "company.wd1.myworkdayjobs.com" (the full Workday subdomain), ats_slug = the path segment like "External" or "CompanyNameCareers"
- "ashby": ats_slug used in https://api.ashbyhq.com/posting-api/job-board/ATS_SLUG — typically lowercase (e.g. "notion", "linear", "retool")
- "plain": careers_url = the company's careers page URL (full URL with https://)

Rules:
- For greenhouse/lever/ashby: make your best guess at the slug (usually lowercase company name or abbreviation)
- Always set ats_slug to null for "plain" type and set careers_url instead
- Always set careers_url to null for greenhouse/lever/ashby (they don't need it)
- Order candidates from most likely to least likely

Return raw JSON only, no markdown.`;

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '[]';
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    return [];
  }
}

async function validateAtsCandidate(candidate: {
  ats_type: string; slug?: string | null; careers_url?: string | null;
}): Promise<boolean> {
  try {
    if (candidate.ats_type === 'greenhouse' && candidate.slug) {
      const r = await fetch(
        `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(candidate.slug)}/jobs`,
        { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      return r.ok;
    }
    if (candidate.ats_type === 'lever' && candidate.slug) {
      const r = await fetch(
        `https://api.lever.co/v0/postings/${encodeURIComponent(candidate.slug)}?mode=json`,
        { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!r.ok) return false;
      const data = await r.json();
      return Array.isArray(data); // valid Lever boards return an array
    }
    if (candidate.ats_type === 'ashby' && candidate.slug) {
      const r = await fetch(
        `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(candidate.slug)}`,
        { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      if (!r.ok) return false;
      const data = await r.json() as { jobPostings?: unknown; jobs?: unknown };
      return !!(data && (data.jobPostings || data.jobs));
    }
    if (candidate.ats_type === 'workday' && candidate.careers_url) {
      // Workday validation: just check the subdomain root resolves
      const domain = (candidate.careers_url as string).replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const r = await fetch(
        `https://${domain}/`,
        { signal: AbortSignal.timeout(10000), method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      return r.status < 500;
    }
    if (candidate.ats_type === 'plain' && candidate.careers_url) {
      const r = await fetch(candidate.careers_url,
        { signal: AbortSignal.timeout(8000), method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      return r.status < 400;
    }
    return false;
  } catch {
    return false;
  }
}

app.post('/api/companies/detect', async (req: Request, res: Response) => {
  try {
    const { name, website } = req.body as { name: string; website?: string };
    if (!name?.trim()) { res.status(400).json({ error: 'Company name required.' }); return; }

    const companyName = name.trim();
    console.log(`[detect] Starting ATS detection for: ${companyName}`);

    // Get Claude's candidates
    const candidates = await detectAtsWithClaude(companyName, website?.trim());
    console.log(`[detect] Claude returned ${candidates.length} candidates for ${companyName}:`, candidates.map(c => `${c.ats_type}/${c.ats_slug || c.careers_url}`).join(', '));

    // Probe each candidate
    let detected: typeof candidates[0] | null = null;
    for (const c of candidates) {
      const valid = await validateAtsCandidate({ ats_type: c.ats_type, slug: c.ats_slug, careers_url: c.careers_url });
      console.log(`[detect] ${c.ats_type}/${c.ats_slug || c.careers_url} → ${valid ? 'VALID ✓' : 'invalid ✗'}`);
      if (valid) { detected = c; break; }
    }

    if (detected) {
      // Save with verified status
      const { rows } = await pool.query(
        `INSERT INTO companies (name, ats_type, ats_slug, careers_url, detect_status)
         VALUES ($1,$2,$3,$4,'detected') RETURNING *`,
        [companyName, detected.ats_type, detected.ats_slug ?? null, detected.careers_url ?? null]
      );
      console.log(`[detect] Saved ${companyName} as ${detected.ats_type}/${detected.ats_slug || detected.careers_url}`);
      res.json({ ok: true, company: rows[0], detected: true, ats_type: detected.ats_type, ats_slug: detected.ats_slug, careers_url: detected.careers_url, confidence: detected.confidence });
    } else {
      // Save with first candidate as best guess, mark pending for retry
      const best = candidates[0];
      if (best) {
        const { rows } = await pool.query(
          `INSERT INTO companies (name, ats_type, ats_slug, careers_url, detect_status, last_scan_error)
           VALUES ($1,$2,$3,$4,'pending',$5) RETURNING *`,
          [companyName, best.ats_type, best.ats_slug ?? null, best.careers_url ?? null,
           `Auto-detection tried ${candidates.length} ATS configs — none validated. Will retry on next scout run.`]
        );
        res.json({ ok: true, company: rows[0], detected: false, message: `Couldn't verify ATS for "${companyName}" — saved best guess (${best.ats_type}). Will retry automatically.` });
      } else {
        // Claude gave us nothing — save as plain with flag
        const { rows } = await pool.query(
          `INSERT INTO companies (name, ats_type, detect_status, last_scan_error)
           VALUES ($1,'plain','pending','Claude could not identify an ATS for this company. Please add the careers URL manually.') RETURNING *`,
          [companyName]
        );
        res.json({ ok: true, company: rows[0], detected: false, message: `Could not identify ATS for "${companyName}". Add a careers URL manually if you know it.` });
      }
    }
  } catch (e) {
    console.error('[detect] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Job report enrichment ──────────────────────────────────────────────────────
// Adds computed explanation fields to each job row served from the API.
// These fields implement the "Jobs Report" spec layer (Part 9) without
// extra DB columns — everything is derived at serve time.

interface CriteriaForReport {
  target_roles: string[];
  must_have: string[];
  nice_to_have: string[];
  locations: string[];
  work_type: string;
  min_salary: number | null;
  avoid: string[];
}

/**
 * Deterministic score (0–100) computed purely from data, with no LLM involvement.
 * Evaluates: title match, keyword match, location match, salary match,
 * source quality (direct company page > aggregator), and description completeness.
 */
function computeDeterministicScore(job: Record<string, unknown>, criteria: CriteriaForReport): number {
  let score = 0;

  const titleLower = (job.title as string ?? '').toLowerCase();
  const descLower  = ((job.description as string ?? '') + ' ' + (job.why_good_fit as string ?? '')).toLowerCase();
  const loc        = (job.location as string ?? '').toLowerCase();
  const applyUrl   = job.apply_url as string ?? '';

  // 1. Title match strength (up to 35 pts)
  const titleMatches = criteria.target_roles.filter(r => titleLower.includes(r.toLowerCase()));
  score += Math.min(35, titleMatches.length * 12 + (titleMatches.length > 0 ? 5 : 0));

  // 2. Must-have keyword match in title or description (up to 25 pts)
  const mustHaveHits = criteria.must_have.filter(k => titleLower.includes(k.toLowerCase()) || descLower.includes(k.toLowerCase()));
  const mustHaveRatio = criteria.must_have.length > 0 ? mustHaveHits.length / criteria.must_have.length : 0;
  score += Math.round(mustHaveRatio * 25);

  // 3. Location / work-type match (up to 20 pts)
  const isRemote = loc.includes('remote') || loc === '';
  if (criteria.work_type === 'remote' && isRemote) score += 20;
  else if (criteria.work_type === 'remote' && !isRemote) score += 0;
  else if (criteria.locations.some(l => loc.includes(l.toLowerCase()))) score += 20;
  else score += 8; // partial credit for unknown locations

  // 4. Salary match (up to 10 pts)
  const salaryStr = job.salary as string ?? '';
  if (salaryStr && criteria.min_salary) {
    const nums = salaryStr.match(/[\d,]+/g);
    if (nums) {
      const highest = Math.max(...nums.map(n => parseInt(n.replace(/,/g, ''), 10)));
      if (!isNaN(highest) && highest >= 1000) {
        score += highest >= criteria.min_salary ? 10 : 0;
      }
    }
  } else if (!criteria.min_salary) {
    score += 5; // no salary filter → partial credit
  }

  // 5. Direct company page boost (up to 10 pts)
  if (isDirectCompanyUrl(applyUrl)) score += 10;

  return Math.min(100, Math.max(0, score));
}

/**
 * Derives a human-readable explanation of why a job ranked where it did.
 */
function buildRankExplanation(job: Record<string, unknown>, detScore: number): string {
  const tier  = job.opportunity_tier as string ?? '';
  const score = job.match_score as number ?? 0;
  const parts: string[] = [];

  if (score >= 75) parts.push(`Strong AI match (${score}/100)`);
  else if (score >= 60) parts.push(`Good AI match (${score}/100)`);
  else parts.push(`Moderate match (${score}/100)`);

  if (detScore >= 60) parts.push(`high deterministic fit score (${detScore}/100)`);

  if (tier === 'Top Target')    parts.push('classified Top Target based on role fit + company quality');
  else if (tier === 'Fast Win') parts.push('classified Fast Win — achievable with current experience');
  else if (tier === 'Stretch Role') parts.push('classified Stretch Role — ambitious but relevant');
  else if (tier === 'Probably Skip') parts.push('de-prioritised by scoring engine');

  const src = job.source as string ?? '';
  if (['Greenhouse','Lever','Workday'].includes(src)) parts.push(`found via direct ${src} ATS`);
  else if (src === 'Gemini') parts.push('discovered via Gemini + Google Search grounding');

  return parts.join('; ');
}

/**
 * Adds computed report fields to a raw job DB row.
 * No extra DB queries — all derived from existing columns + criteria.
 */
function enrichJobRecord(job: Record<string, unknown>, criteria: CriteriaForReport): Record<string, unknown> {
  const applyUrl    = job.apply_url as string ?? '';
  const detScore    = computeDeterministicScore(job, criteria);

  // Extract Gemini grounding metadata for surfacing in the API
  const groundingRaw = job.gemini_grounding_metadata as Record<string, unknown> | null;
  const geminiWebSearchQueries: string[] = groundingRaw?.webSearchQueries as string[] ?? [];
  const geminiSources = ((groundingRaw?.groundingChunks as Array<{web?: {uri?: string; title?: string}}> | undefined) ?? [])
    .filter(c => c?.web?.uri)
    .map(c => ({ uri: c.web!.uri!, title: c.web!.title }));

  // Matched settings: which of the user's criteria does this job satisfy?
  const titleLower = (job.title as string ?? '').toLowerCase();
  const descLower  = ((job.description as string ?? '') + ' ' + (job.why_good_fit as string ?? '')).toLowerCase();
  const matchedSettings: Record<string, unknown> = {
    matched_roles:     criteria.target_roles.filter(r => titleLower.includes(r.toLowerCase())),
    matched_must_have: criteria.must_have.filter(k => titleLower.includes(k.toLowerCase()) || descLower.includes(k.toLowerCase())),
    matched_nice_to_have: criteria.nice_to_have.filter(k => descLower.includes(k.toLowerCase())),
    location_match:    criteria.locations.length === 0 || criteria.locations.some(l => (job.location as string ?? '').toLowerCase().includes(l.toLowerCase())) || (job.location as string ?? '').toLowerCase().includes('remote'),
  };

  return {
    ...job,
    // Deterministic score (separate from LLM match_score)
    deterministic_score: detScore,
    // Source provenance
    source_found_from:          job.source,
    direct_company_page_found:  isDirectCompanyUrl(applyUrl),
    // Explanation fields
    explanation_for_rank:  buildRankExplanation(job, detScore),
    matched_settings:      matchedSettings,
    // Gemini grounding data (null for non-Gemini jobs)
    gemini_web_search_queries: geminiWebSearchQueries,
    gemini_sources:            geminiSources.length > 0 ? geminiSources : undefined,
    // Freshness: job is "new" if found within last 48 h OR posted within 3 days
    is_new: (() => {
      const foundAt = job.found_at ? new Date(job.found_at as string) : null;
      const now = Date.now();
      if (foundAt && (now - foundAt.getTime()) < 48 * 60 * 60 * 1000) return true;
      const dp = job.date_posted as string | null;
      if (dp) {
        const posted = new Date(dp);
        if (!isNaN(posted.getTime()) && (now - posted.getTime()) < 3 * 24 * 60 * 60 * 1000) return true;
      }
      return false;
    })(),
    date_posted: job.date_posted ?? null,
    url_ok:      job.url_ok      ?? null,
    // ── Canonical URL & validation fields ──────────────────────────────────────
    canonical_url:           (job.canonical_url as string | null) ?? applyUrl,
    original_url:            (job.original_url  as string | null) ?? applyUrl,
    canonical_source:        (job.canonical_source as string | null) ?? classifySourceTrust(applyUrl),
    link_confidence:         (job.link_confidence as string | null) ?? computeLinkConfidence(applyUrl, job.url_ok as boolean | null, false),
    was_resolved_by_gemini:  job.was_resolved_by_gemini ?? false,
    validation_notes:        job.validation_notes ?? null,
    validation_status:       (job.validation_status as string | null) ?? 'pending',
    page_type:               (job.page_type as string | null) ?? null,
    // ── Resolved / recovered metadata fields ───────────────────────────────────
    resolved_title:          (job.resolved_title as string | null) ?? null,
    resolved_description:    (job.resolved_description as string | null) ?? null,
    resolved_location:       (job.resolved_location as string | null) ?? null,
    original_title:          (job.original_title as string | null) ?? (job.title as string),
    original_description:    (job.original_description as string | null) ?? null,
    metadata_last_verified_at: (job.metadata_last_verified_at as string | null) ?? null,
    // ── Display fields: prefer recovered/canonical data over scraped ────────────
    // Only use resolved_title if it looks like an actual job title (not a careers listing page)
    display_title: (() => {
      const rt = job.resolved_title as string | null;
      if (rt) {
        const low = rt.toLowerCase().trim();
        const isBadTitle = low.startsWith('current opening') || low.startsWith('open role') ||
          low.startsWith('job opportunit') || low.startsWith('career') ||
          low.endsWith('careers') || low.endsWith(' jobs') || /\bcurrent opening/.test(low);
        if (!isBadTitle) return rt;
      }
      return job.title as string;
    })(),
    display_description: (() => {
      const rd = job.resolved_description as string | null;
      if (rd) {
        const low = rd.toLowerCase().slice(0, 80);
        const isBad = low.includes('current opening') || low.includes('create a job alert') ||
          low.includes('open roles') || low.includes('job opportunities');
        if (!isBad) return rd;
      }
      return (job.description as string | null) ?? null;
    })(),
    display_url:         ((job.canonical_url as string | null) ?? applyUrl),
    display_location:    ((job.resolved_location as string | null) ?? (job.location as string | null) ?? null),
  };
}

// Jobs
app.get('/api/jobs', async (req: Request, res: Response) => {
  try {
    const minScore = Number(req.query.min_score) || 0;
    const hideLowConfidence = req.query.hide_low_confidence === 'true';
    const sort = req.query.sort === 'score' ? 'match_score DESC, found_at DESC' : 'found_at DESC, match_score DESC';

    // Load criteria once for enrichment (deterministic score + explanation fields)
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    const criteriaForReport: CriteriaForReport = cRows.length > 0 ? {
      target_roles: cRows[0].target_roles ?? [],
      must_have:    cRows[0].must_have    ?? [],
      nice_to_have: cRows[0].nice_to_have ?? [],
      locations:    cRows[0].locations    ?? [],
      work_type:    cRows[0].work_type    ?? 'any',
      min_salary:   cRows[0].min_salary   ?? null,
      avoid:        cRows[0].avoid        ?? [],
    } : { target_roles: [], must_have: [], nice_to_have: [], locations: [], work_type: 'any', min_salary: null, avoid: [] };

    const { rows } = await pool.query(
      `SELECT j.*,
              cm.momentum_score AS momentum_score,
              cm.signals        AS momentum_signals
       FROM jobs j
       LEFT JOIN LATERAL (
         SELECT momentum_score, signals
         FROM company_momentum
         WHERE LOWER(company_name) = LOWER(j.company)
           AND created_at > NOW() - INTERVAL '48 hours'
         ORDER BY created_at DESC
         LIMIT 1
       ) cm ON true
       WHERE j.match_score >= $1
         ${hideLowConfidence ? "AND (j.link_confidence IS NULL OR j.link_confidence NOT IN ('low') OR j.was_resolved_by_gemini = true)" : ''}
       ORDER BY ${sort}`,
      [minScore]
    );

    // Attach salary estimates for jobs missing salary
    for (const j of rows) {
      if (!j.salary || j.salary === 'Unknown' || j.salary === 'N/A' || (j.salary as string).trim() === '') {
        const { rows: est } = await pool.query(
          `SELECT estimate_json FROM salary_estimates WHERE LOWER(job_title) = LOWER($1) AND LOWER(company_name) = LOWER($2) AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 1`,
          [j.title, j.company]
        );
        if (est.length > 0) {
          (j as Record<string, unknown>).salary_estimate = est[0].estimate_json;
        }
      }
    }

    // Enrich every job record with computed explanation fields:
    // deterministic_score, direct_company_page_found, explanation_for_rank,
    // matched_settings, gemini_web_search_queries, gemini_sources, source_found_from, is_live
    const enriched = rows.map((j: Record<string, unknown>) => enrichJobRecord(j, criteriaForReport));

    res.json(enriched);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Source breakdown — returns count of jobs per discovery source
// Manually trigger canonical URL re-validation for broken / low-confidence links
app.post('/api/jobs/re-validate', async (_req, res: Response) => {
  try {
    res.json({ ok: true, message: 'Canonical URL resolution started in background' });
    runCanonicalResolutionInBackground(pool).catch(() => {});
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).json({ error: msg });
  }
});

app.get('/api/jobs/source-breakdown', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        source,
        COUNT(*)::int AS count,
        ROUND(AVG(match_score))::int AS avg_score,
        COUNT(*) FILTER (WHERE gemini_grounding_metadata IS NOT NULL)::int AS with_grounding
      FROM jobs
      GROUP BY source
      ORDER BY count DESC
    `);
    const total = rows.reduce((sum: number, r: Record<string, unknown>) => sum + (r.count as number), 0);
    res.json({ breakdown: rows, total });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Career Intel routes ───────────────────────────────────────────────────────
// GET  /api/career-intel        — return cached result (stale flag if >24h)
// POST /api/career-intel/refresh — regenerate synchronously and persist

app.get('/api/career-intel', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT result_json, generated_at FROM career_intel ORDER BY generated_at DESC LIMIT 1`
    );
    if (rows.length === 0) {
      res.json({ data: null, stale: true, message: 'No intel generated yet. Click Refresh Intel to generate.' }); return;
    }
    const row = rows[0];
    const age = Date.now() - new Date(row.generated_at).getTime();
    const stale = age > 24 * 60 * 60 * 1000; // 24 hours
    res.json({ data: row.result_json, generated_at: row.generated_at, stale });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/career-intel/refresh', async (_req, res: Response) => {
  try {
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    if (cRows.length === 0) {
      res.status(400).json({ error: 'No search criteria configured. Set your preferences in Settings first.' }); return;
    }
    const c = cRows[0];
    const criteria: CareerIntelCriteria = {
      target_roles:     c.target_roles     ?? [],
      industries:       c.industries       ?? [],
      locations:        c.locations        ?? [],
      work_type:        c.work_type        ?? 'any',
      must_have:        c.must_have        ?? [],
      nice_to_have:     c.nice_to_have     ?? [],
      avoid:            c.avoid            ?? [],
      min_salary:       c.min_salary       ?? null,
      experience_levels: c.experience_levels ?? [],
      vertical_niches:  c.vertical_niches  ?? [],
    };

    console.log('[CareerIntel] Manual refresh triggered via API');
    const result = await generateCareerIntel(criteria);

    // Persist result (keep only last 5 records to avoid unbounded growth)
    await pool.query(
      `INSERT INTO career_intel (result_json, generated_at) VALUES ($1, NOW())`,
      [JSON.stringify(result)]
    );
    await pool.query(
      `DELETE FROM career_intel WHERE id NOT IN (SELECT id FROM career_intel ORDER BY generated_at DESC LIMIT 5)`
    );

    res.json({ data: result, generated_at: result.generated_at, stale: false });
  } catch (e) {
    console.error('[CareerIntel] Refresh failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Job Market Pulse ─────────────────────────────────────────────────────────
// GET  /api/job-market-pulse         — cached result (stale if >24h)
// POST /api/job-market-pulse/refresh — generate fresh analysis

app.get('/api/job-market-pulse', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(
      `SELECT result_json, generated_at FROM job_market_pulse ORDER BY generated_at DESC LIMIT 1`
    );
    if (rows.length === 0) {
      res.json({ data: null, stale: true, message: 'No pulse data yet. Click Refresh to generate.' }); return;
    }
    const row = rows[0];
    const stale = Date.now() - new Date(row.generated_at).getTime() > 24 * 60 * 60 * 1000;
    res.json({ data: row.result_json, generated_at: row.generated_at, stale });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/job-market-pulse/refresh', async (_req, res: Response) => {
  try {
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    if (cRows.length === 0) {
      res.status(400).json({ error: 'Configure your search settings first.' }); return;
    }
    const c = cRows[0];

    // Pull scout-collected company stats from the last 30 days
    const { rows: jobRows } = await pool.query(`
      SELECT
        company,
        COUNT(*)::int                AS job_count,
        ARRAY_AGG(DISTINCT title)    AS roles,
        MAX(created_at)::text        AS newest_posting,
        ARRAY_AGG(DISTINCT location) FILTER (WHERE location IS NOT NULL AND location <> '') AS locations
      FROM jobs
      WHERE created_at >= NOW() - INTERVAL '30 days'
        AND company IS NOT NULL AND company <> ''
      GROUP BY company
      ORDER BY job_count DESC
      LIMIT 20
    `);

    const scoutStats: ScoutCompanyStat[] = jobRows.map(r => ({
      company_name:   r.company,
      job_count:      r.job_count,
      roles:          (r.roles ?? []).filter(Boolean).slice(0, 6),
      avg_salary:     null,
      max_salary:     null,
      newest_posting: r.newest_posting ?? new Date().toISOString(),
      locations:      (r.locations ?? []).filter(Boolean).slice(0, 4),
    }));

    if (scoutStats.length === 0) {
      res.status(400).json({ error: 'No scout data collected yet — run the job scout first to collect company data.' }); return;
    }

    const criteria = {
      target_roles: c.target_roles ?? [],
      industries:   c.industries   ?? [],
      min_salary:   c.min_salary   ?? null,
    };

    console.log(`[JobMarketPulse] Manual refresh — ${scoutStats.length} companies`);
    const result = await generateJobMarketPulse(scoutStats, criteria);

    await pool.query(
      `INSERT INTO job_market_pulse (result_json, generated_at) VALUES ($1, NOW())`,
      [JSON.stringify(result)]
    );
    await pool.query(
      `DELETE FROM job_market_pulse WHERE id NOT IN (SELECT id FROM job_market_pulse ORDER BY generated_at DESC LIMIT 5)`
    );

    res.json({ data: result, generated_at: result.generated_at, stale: false });
  } catch (e) {
    console.error('[JobMarketPulse] Refresh failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Pre-IPO Intelligence ───────────────────────────────────────────────────────
// GET  /api/preipo        — return cached result (stale flag if >24h)
// POST /api/preipo/refresh — regenerate synchronously and persist

app.get('/api/preipo', async (_req, res: Response) => {
  try {
    const cached = await getLatestPreIpo(pool);
    if (!cached) { res.json({ data: null, stale: false }); return; }
    res.json({ data: cached.data, generated_at: cached.data.generated_at, stale: cached.stale });
  } catch (e) {
    console.error('[PreIPO] GET failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/preipo/refresh', async (_req, res: Response) => {
  try {
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    const c = cRows[0] ?? {};
    const criteria: PreIpoCriteria = {
      target_roles:    c.target_roles    ?? [],
      industries:      c.industries      ?? [],
      locations:       c.locations       ?? [],
      must_have:       c.must_have       ?? [],
      vertical_niches: c.vertical_niches ?? [],
      min_salary:      c.min_salary      ?? null,
    };
    console.log('[PreIPO] Manual refresh triggered via API');
    const result = await generatePreIpo(criteria);
    await savePreIpo(pool, result);
    res.json({ data: result, generated_at: result.generated_at, stale: false });
  } catch (e) {
    console.error('[PreIPO] Refresh failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Industry Leaders ───────────────────────────────────────────────────────────
// GET  /api/industry-leaders        — return cached result (stale flag if >7d)
// POST /api/industry-leaders/refresh — regenerate with Claude and persist

app.get('/api/industry-leaders', async (_req, res: Response) => {
  try {
    const cached = await getLatestIndustryLeaders(pool);
    if (!cached) { res.json({ data: null, stale: false }); return; }
    res.json({ data: cached.data, generated_at: cached.data.generated_at, stale: cached.stale });
  } catch (e) {
    console.error('[IndustryLeaders] GET failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/industry-leaders/refresh', async (_req, res: Response) => {
  try {
    console.log('[IndustryLeaders] Refresh triggered');
    const result = await generateIndustryLeaders();
    await saveIndustryLeaders(pool, result);
    res.json({ data: result, generated_at: result.generated_at, stale: false });
  } catch (e) {
    console.error('[IndustryLeaders] Refresh failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Deep Value Intelligence ────────────────────────────────────────────────────
app.get('/api/deep-value', async (_req, res: Response) => {
  try {
    const cached = await getLatestDeepValue(pool);
    if (!cached) { res.json({ data: null, stale: false }); return; }
    res.json({ data: cached.data, generated_at: cached.data.generated_at, stale: cached.stale });
  } catch (e) {
    console.error('[DeepValue] GET failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/deep-value/refresh', async (_req, res: Response) => {
  try {
    console.log('[DeepValue] Refresh triggered');
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    const c = cRows[0] ?? {};
    const result = await generateDeepValue({
      target_roles: c.target_roles ?? [],
      locations:    c.locations    ?? ['Remote'],
      min_salary:   c.min_salary   ?? null,
    });
    await saveDeepValue(pool, result);
    res.json({ data: result, generated_at: result.generated_at, stale: false });
  } catch (e) {
    console.error('[DeepValue] Refresh failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Industry News ──────────────────────────────────────────────────────────────
let newsRefreshRunning = false;

app.get('/api/industry-news', async (_req, res: Response) => {
  try {
    const { articles, meta } = await getLatestNews(pool, 80);
    res.json({ articles, meta, stale: !meta || !articles.length });
  } catch (e) {
    console.error('[IndustryNews] GET failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/industry-news/refresh', async (_req, res: Response) => {
  if (newsRefreshRunning) { res.json({ queued: true, message: 'Refresh already in progress' }); return; }
  newsRefreshRunning = true;
  res.json({ started: true });
  try {
    const geminiKey = process.env.GEMINI_API_KEY ?? '';
    await refreshIndustryNews(pool, geminiKey);
  } catch (e) {
    console.error('[IndustryNews] Refresh failed:', e);
  } finally {
    newsRefreshRunning = false;
  }
});

// ── Company Watchlist job scan ─────────────────────────────────────────────────
// GET  /api/companies/job-status   — return cached scan results for all watchlist companies
// POST /api/companies/scan-jobs    — run Gemini job scan for all companies in watchlist

app.get('/api/companies/job-status', async (_req, res: Response) => {
  try {
    const results = await getCompanyJobScanResults(pool);
    res.json(results);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

let watchlistScanRunning = false;

app.post('/api/companies/scan-jobs', async (_req, res: Response) => {
  if (watchlistScanRunning) { res.json({ started: false, message: 'Scan already running' }); return; }
  try {
    const { rows: companies } = await pool.query('SELECT name FROM companies ORDER BY name');
    if (companies.length === 0) { res.json({ started: false, message: 'No companies in watchlist' }); return; }
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    const c = cRows[0] ?? {};
    res.json({ started: true, count: companies.length });
    watchlistScanRunning = true;
    (async () => {
      try {
        console.log(`[WatchlistScan] Scanning ${companies.length} companies for open roles…`);
        for (const co of companies) {
          try {
            const jobs = await scanWatchlistCompanyJobs(pool, co.name, {
              target_roles: c.target_roles ?? [],
              locations:    c.locations    ?? ['Remote'],
            });
            await upsertCompanyJobScan(pool, co.name, jobs);
            console.log(`[WatchlistScan] ${co.name}: ${jobs.length} roles found`);
          } catch (e) {
            console.error(`[WatchlistScan] Error for ${co.name}:`, e);
            await upsertCompanyJobScan(pool, co.name, []);
          }
        }
        console.log('[WatchlistScan] Complete');
      } finally { watchlistScanRunning = false; }
    })();
  } catch (e) { watchlistScanRunning = false; res.status(500).json({ error: String(e) }); }
});

// ── Positioning Engine Routes ──────────────────────────────────────────────────
app.get('/api/positioning/profile', async (_req, res: Response) => {
  try { res.json(await getProfile(pool) || {}); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/positioning/profile', async (req, res: Response) => {
  try { await saveProfile(pool, req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/positioning/stories', async (_req, res: Response) => {
  try { res.json(await getStories(pool)); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/positioning/stories', async (req, res: Response) => {
  try { res.json(await saveStory(pool, req.body)); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/positioning/stories/:id', async (req, res: Response) => {
  try { await deleteStory(pool, parseInt(req.params.id)); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/positioning/outputs', async (_req, res: Response) => {
  try { res.json(await getOutputs(pool) || {}); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/positioning/generate', async (_req, res: Response) => {
  try {
    const profile = await getProfile(pool);
    if (!profile || !profile.target_role) { res.status(400).json({ error: 'Complete the intake form first.' }); return; }
    const stories = await getStories(pool);
    const outputs = await generateOutputs(pool, profile, stories);
    res.json(outputs);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/positioning/objections', async (_req, res: Response) => {
  try { res.json(await getObjections(pool) || {}); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/positioning/generate-objections', async (_req, res: Response) => {
  try {
    const profile = await getProfile(pool);
    if (!profile || !profile.target_role) { res.status(400).json({ error: 'Complete the intake form first.' }); return; }
    const stories = await getStories(pool);
    const result = await generateObjections(pool, profile, stories);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/positioning/narrative', async (_req, res: Response) => {
  try { res.json(await getNarrative(pool) || {}); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/positioning/narrative', async (req, res: Response) => {
  try { await saveNarrative(pool, req.body); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/positioning/draft-narrative', async (_req, res: Response) => {
  try {
    const profile = await getProfile(pool);
    if (!profile || !profile.target_role) { res.status(400).json({ error: 'Complete the intake form first.' }); return; }
    const stories = await getStories(pool);
    const draft = await draftNarrative(pool, profile, stories);
    res.json(draft);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/jobs/saved', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM jobs WHERE saved_at IS NOT NULL ORDER BY saved_at DESC LIMIT 200'
    );
    // Attach salary estimates for jobs missing salary
    for (const j of rows) {
      if (!j.salary || j.salary === 'Unknown' || j.salary === 'N/A' || j.salary.trim() === '') {
        const { rows: est } = await pool.query(
          `SELECT estimate_json FROM salary_estimates WHERE LOWER(job_title) = LOWER($1) AND LOWER(company_name) = LOWER($2) AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 1`,
          [j.title, j.company]
        );
        if (est.length > 0) j.salary_estimate = est[0].estimate_json;
      }
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/jobs/:id/save', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      'UPDATE jobs SET saved_at = NOW() WHERE id = $1 RETURNING *', [req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.delete('/api/jobs/:id/save', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query(
      'UPDATE jobs SET saved_at = NULL WHERE id = $1 RETURNING *', [req.params.id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── User action tracking (applied, interested, skipped, etc.) ─────────────
app.put('/api/jobs/:id/action', async (req: Request, res: Response) => {
  try {
    const valid = ['applied', 'interested', 'interviewing', 'rejected', 'skipped', 'none'];
    const action: string = req.body?.action;
    if (!action || !valid.includes(action)) {
      res.status(400).json({ error: 'Invalid action. Must be: ' + valid.join(', ') }); return;
    }
    const { rows } = await pool.query(
      action === 'none'
        ? 'UPDATE jobs SET user_action=NULL, user_action_at=NULL WHERE id=$1 RETURNING *'
        : 'UPDATE jobs SET user_action=$1, user_action_at=NOW() WHERE id=$2 RETURNING *',
      action === 'none' ? [req.params.id] : [action, req.params.id]
    );
    if (!rows.length) { res.status(404).json({ error: 'Job not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Preference profile — Claude analysis of behavioral patterns ─────────────
app.get('/api/jobs/preference-profile', async (_req, res: Response) => {
  try {
    const { rows: actions } = await pool.query(
      `SELECT j.title, j.company, j.location, j.salary, j.match_score,
              j.opportunity_tier, j.sub_scores, j.source, j.user_action, j.user_action_at
       FROM jobs j WHERE j.user_action IS NOT NULL AND j.user_action != 'none'
       ORDER BY j.user_action_at DESC LIMIT 60`
    );
    if (actions.length < 3) {
      res.json({ profile: null, action_count: actions.length, message: 'Mark at least 3 jobs (applied, interested, or skipped) to generate your preference profile.' });
      return;
    }

    const actionSummary = actions.map(j =>
      `${(j.user_action as string).toUpperCase()}: ${j.title} @ ${j.company} | Score: ${j.match_score} | Tier: ${j.opportunity_tier} | Salary: ${j.salary || 'not listed'} | Location: ${j.location}`
    ).join('\n');

    const prompt = `You are analyzing a sales professional's behavioral patterns to reveal their revealed job preferences — not what they claim to want, but what their actual actions show.

Their recent job actions:
${actionSummary}

Write a preference profile with these 5 parts:
1. **Role Fit**: What role types and seniority levels do they actually engage with?
2. **Company Signal**: What company characteristics attract them (stage, industry, size)?
3. **Compensation Pattern**: What does their behavior reveal about salary tolerance?
4. **Hidden Insight**: One surprising or counterintuitive finding from their actual choices.
5. **Action**: One concrete thing to adjust in their search criteria based on this data.

Be direct and specific. Use the actual data points. 1-2 sentences per section. Under 280 words total.`;

    const AnthropicSdk2 = (await import('@anthropic-ai/sdk')).default;
    const ac2 = new AnthropicSdk2({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
      ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL } : {}),
    });
    const response = await ac2.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 450,
      messages: [{ role: 'user', content: prompt }],
    });
    const profile = response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
    const breakdown = {
      applied:      actions.filter(a => a.user_action === 'applied').length,
      interested:   actions.filter(a => a.user_action === 'interested').length,
      interviewing: actions.filter(a => a.user_action === 'interviewing').length,
      rejected:     actions.filter(a => a.user_action === 'rejected').length,
      skipped:      actions.filter(a => a.user_action === 'skipped').length,
    };
    res.json({ profile, action_count: actions.length, breakdown });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Pipeline — all tracked jobs grouped by status ─────────────────────────
app.get('/api/pipeline', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT j.*,
        EXTRACT(EPOCH FROM (NOW() - j.user_action_at)) / 86400 AS days_in_stage,
        td.resume_text AS tailored_resume,
        td.cover_letter AS tailored_cover_letter,
        (SELECT COUNT(*) FROM tailored_docs WHERE job_id = j.id) AS has_docs
      FROM jobs j
      LEFT JOIN tailored_docs td ON td.job_id = j.id
      WHERE j.user_action IS NOT NULL AND j.user_action NOT IN ('none','skipped')
      ORDER BY j.user_action_at DESC
    `);
    const grouped: Record<string, any[]> = {
      interested: [], applied: [], interviewing: [], rejected: []
    };
    for (const r of rows) {
      const k = r.user_action as string;
      if (grouped[k]) grouped[k].push(r);
    }
    res.json(grouped);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Pipeline daily actions — Claude recommends top 3 moves ────────────────
app.post('/api/pipeline/daily-actions', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(`
      SELECT title, company, user_action, user_action_at, match_score, opportunity_tier,
        EXTRACT(EPOCH FROM (NOW() - user_action_at)) / 86400 AS days_in_stage,
        interview_prep_at
      FROM jobs
      WHERE user_action IS NOT NULL AND user_action NOT IN ('none','skipped')
      ORDER BY user_action_at DESC LIMIT 20
    `);
    if (!rows.length) {
      res.json({ actions: [], message: 'Start tracking jobs to get daily action recommendations.' }); return;
    }
    const pipelineSummary = rows.map(r =>
      `- ${r.title} @ ${r.company}: ${r.user_action} (${Math.round(r.days_in_stage)}d ago)${r.interview_prep_at ? ' [prep ready]' : ''}`
    ).join('\n');
    const prompt = `You are an executive career coach giving a job seeker their most important actions for today.

Current pipeline:
${pipelineSummary}

Generate exactly 3 specific, actionable recommendations for TODAY. Each action should be:
- Specific to an actual job/company in the pipeline
- Clear on WHY it matters now (urgency, timing, next step)
- One sentence, direct, no fluff

Format as JSON array:
[
  {"icon":"📝","action":"Follow up with [Company] — you applied 8 days ago and haven't heard back. A brief email today keeps you top of mind.","urgency":"high"},
  {"icon":"🎯","action":"...","urgency":"medium"},
  {"icon":"⚡","action":"...","urgency":"low"}
]

Return raw JSON only.`;
    const Asdk = (await import('@anthropic-ai/sdk')).default;
    const ac = new Asdk({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
      ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL } : {}),
    });
    const msg = await ac.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 400,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw = msg.content[0]?.type === 'text' ? msg.content[0].text.trim() : '[]';
    let actions: any[] = [];
    try {
      const clean = raw.replace(/^```json\s*/,'').replace(/```$/,'').trim();
      actions = JSON.parse(clean);
    } catch { actions = []; }
    res.json({ actions });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Interview Prep — generate battle card for a job ───────────────────────
app.post('/api/jobs/:id/interview-prep', async (req: Request, res: Response) => {
  try {
    const jobId = Number(req.params.id);
    const { rows: jRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (!jRows.length) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = jRows[0] as any;

    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    const crit = cRows[0] as any;
    const { rows: rRows } = await pool.query("SELECT value FROM settings WHERE key='resume' LIMIT 1");
    const resumeText = rRows[0]?.value || crit?.resume || '';

    const { rows: researchRows } = await pool.query(
      `SELECT result_json FROM job_research WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1`, [jobId]
    );
    const researchSnippet = researchRows[0]?.result_json
      ? JSON.stringify(researchRows[0].result_json).slice(0, 800)
      : 'No prior research available.';

    const jdSnippet = (job.description || job.title + ' at ' + job.company).slice(0, 1200);

    const prompt = `You are an expert interview coach. Generate a concise interview battle card.

Role: ${job.title} at ${job.company}
Location: ${job.location || 'Remote'}
Salary: ${job.salary || 'Not listed'}

Job Description (excerpt):
${jdSnippet}

Candidate Resume (excerpt):
${resumeText.slice(0, 1000)}

Company Research:
${researchSnippet}

Generate a battle card with these exact sections. Be specific and practical:

1. COMPANY_SNAPSHOT: 2-3 sentences: what they do, stage, why they're hiring now
2. TOP_QUESTIONS: 5 likely interview questions for this specific role (numbered list)
3. YOUR_BEST_ANSWERS: For each question above, 1-2 sentence answer starter leveraging the candidate's actual background
4. YOUR_PITCH: One-sentence "why I want this role and why I'm the right person" talking point
5. WATCH_OUT: 1-2 things to be ready for (culture fit, comp negotiation, competitive concern)

Format as JSON:
{
  "company_snapshot": "...",
  "top_questions": ["Q1","Q2","Q3","Q4","Q5"],
  "answer_starters": ["A1","A2","A3","A4","A5"],
  "your_pitch": "...",
  "watch_out": ["W1","W2"]
}

Return raw JSON only.`;

    const Asdk2 = (await import('@anthropic-ai/sdk')).default;
    const ac2 = new Asdk2({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
      ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL } : {}),
    });
    const msg2 = await ac2.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 900,
      messages: [{ role: 'user', content: prompt }]
    });
    const raw2 = msg2.content[0]?.type === 'text' ? msg2.content[0].text.trim() : '{}';
    let prepData: any = {};
    try {
      const clean2 = raw2.replace(/^```json\s*/,'').replace(/```$/,'').trim();
      prepData = JSON.parse(clean2);
    } catch { prepData = { error: 'Failed to parse battle card', raw: raw2.slice(0,200) }; }

    await pool.query(
      `UPDATE jobs SET interview_prep_json=$1, interview_prep_at=NOW() WHERE id=$2`,
      [JSON.stringify(prepData), jobId]
    );
    res.json({ prep: prepData, job_id: jobId });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Interview Prep — get cached battle card ───────────────────────────────
app.get('/api/jobs/:id/interview-prep', async (req: Request, res: Response) => {
  try {
    const jobId = Number(req.params.id);
    const { rows } = await pool.query(
      'SELECT interview_prep_json, interview_prep_at, title, company FROM jobs WHERE id=$1', [jobId]
    );
    if (!rows.length) { res.status(404).json({ error: 'Job not found' }); return; }
    const row = rows[0] as any;
    if (!row.interview_prep_json) { res.json({ prep: null }); return; }
    let prep: any;
    try { prep = JSON.parse(row.interview_prep_json); } catch { prep = null; }
    res.json({ prep, generated_at: row.interview_prep_at, title: row.title, company: row.company });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── LinkedIn outreach message generator ───────────────────────────────────
app.post('/api/jobs/:id/outreach', async (req: Request, res: Response) => {
  try {
    const jobId = Number(req.params.id);
    const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (jobRows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = jobRows[0] as any;

    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    const criteria = cRows[0] as any ?? {};
    const { rows: resumeRows } = await pool.query('SELECT content FROM saved_resumes ORDER BY saved_at DESC LIMIT 1');
    const resume = (resumeRows[0]?.content ?? '').slice(0, 2000);

    const prompt = `You are helping a job seeker reach out to someone at ${job.company} about this role: "${job.title}".

Candidate profile (resume excerpt):
${resume || `Sales professional with experience in ${(criteria.industries ?? []).join(', ') || 'enterprise software'}`}

Why this job fits:
${job.why_good_fit || 'Strong match for skills and experience'}

Write two short outreach messages:

1. LinkedIn Connection Request (≤300 characters, no subject line, casual and genuine, mention the specific role):
[CONNECTION REQUEST]
<message here>

2. LinkedIn DM after connecting (3-4 sentences, warm but professional, reference the role, ONE clear ask — a 15-min call):
[LINKEDIN DM]
<message here>

Do not use generic phrases like "I hope this message finds you well". Be specific. Use first person.`;

    const AnthropicSdk3 = (await import('@anthropic-ai/sdk')).default;
    const ac3 = new AnthropicSdk3({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
      ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL } : {}),
    });
    const msg = await ac3.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = (msg.content[0] as any).text as string;

    const connMatch = raw.match(/\[CONNECTION REQUEST\]\s*([\s\S]*?)(?=\[LINKEDIN DM\]|$)/i);
    const dmMatch  = raw.match(/\[LINKEDIN DM\]\s*([\s\S]*?)$/i);

    res.json({
      connection_request: connMatch ? connMatch[1].trim() : raw.slice(0, 300),
      linkedin_dm: dmMatch ? dmMatch[1].trim() : raw,
    });
  } catch (e) {
    console.error('Outreach generation error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Cover Letter Generator ─────────────────────────────────────────────────
// POST /api/jobs/:id/cover-letter
// Two-step Claude: (1) web-search research → specific company facts,
//                 (2) cover letter generation grounded in those facts.
// Result is cached in cover_letters table; pass ?force=true to regenerate.
app.post('/api/jobs/:id/cover-letter', async (req: Request, res: Response) => {
  try {
    const jobId = Number(req.params.id);
    const force = req.query.force === 'true' || req.body?.force === true;

    // 1. Load job record
    const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (jobRows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = jobRows[0] as any;

    // 2. Check cache (skip if force=true)
    if (!force) {
      const { rows: cached } = await pool.query(
        'SELECT * FROM cover_letters WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1',
        [jobId]
      );
      if (cached.length > 0) {
        const c = cached[0] as any;
        let research = null;
        try { if (c.research_context) research = JSON.parse(c.research_context); } catch { /* ignore */ }
        res.json({ cover_letter: c.cover_letter_text, research, cached: true, created_at: c.created_at });
        return;
      }
    }

    // 3. Load user resume
    const { rows: resumeRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
    const resumeText: string = resumeRows[0]?.value ?? '';
    if (!resumeText.trim()) {
      res.status(400).json({ error: 'NO_RESUME', message: 'Please add your resume on the Resume page before generating a cover letter.' });
      return;
    }

    // 4. Load user name, document model, cover letter system prompt, and tailored resume
    const { rows: cRows } = await pool.query('SELECT your_name, your_email FROM criteria LIMIT 1');
    const userName: string = cRows[0]?.your_name ?? '';
    const { rows: dmRows } = await pool.query("SELECT value FROM settings WHERE key='document_model'");
    const documentModel: string = dmRows[0]?.value || 'claude-opus-4-6';
    const { rows: clInstrRows } = await pool.query("SELECT value FROM settings WHERE key='cover_letter_instructions'");
    const coverLetterInstructions: string | null = clInstrRows[0]?.value ?? null;
    // Load cover_letter_writer system prompt from DB (overrides customInstructions if present)
    const { rows: clPromptRows } = await pool.query(
      "SELECT prompt_text FROM system_prompts WHERE prompt_name='cover_letter_writer'"
    );
    const coverLetterSystemPrompt: string | null = clPromptRows[0]?.prompt_text ?? null;
    // Load most recent tailored resume for this job (to give Claude the ATS-matched version)
    const { rows: tailoredRows } = await pool.query(
      'SELECT resume_text FROM tailored_resumes WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1',
      [jobId]
    );
    const tailoredResumeText: string | null = tailoredRows[0]?.resume_text ?? null;

    // 5. Load existing research brief if fresh (< 24h)
    const { rows: briefRows } = await pool.query(
      `SELECT brief_json FROM research_briefs WHERE LOWER(company_name) = LOWER($1) AND status = 'ready' AND created_at > NOW() - INTERVAL '24 hours' ORDER BY created_at DESC LIMIT 1`,
      [job.company]
    );
    const existingResearch = briefRows.length > 0
      ? JSON.stringify(briefRows[0].brief_json).slice(0, 2000)
      : null;

    // 6. Territory detection + analysis (non-fatal)
    const detectedTerritory = detectTerritory(job.title, job.description ?? '');
    let territoryCtx = null;
    if (detectedTerritory) {
      console.log(`[CoverLetter] Territory detected: "${detectedTerritory}" — running territory intelligence`);
      territoryCtx = await analyzeTerritoryContext(job.title, job.company, detectedTerritory, resumeText);
    }

    // 7. Generate cover letter (two-step: research + generation)
    // Use a slightly varied temperature on regenerate to get a different letter
    const temperature = force ? Math.min(1.9, 0.9 + Math.random() * 0.8) : 1.0;
    console.log(`[CoverLetter] Generating for job #${jobId} (${job.title} @ ${job.company}), force=${force}, model=${documentModel}, temperature=${temperature.toFixed(2)}`);

    const result = await generateCoverLetterWithClaude({
      jobTitle: job.title,
      companyName: job.company,
      jobDescription: job.description ?? '',
      resumeText,
      userName,
      existingResearch,
      temperature,
      model: documentModel,
      territoryContext: territoryCtx,
      customInstructions: coverLetterInstructions,
      systemPrompt: coverLetterSystemPrompt,
      tailoredResumeText,
    });

    console.log(`[CoverLetter] Generated (${result.coverLetter.length} chars) | researchFailed=${result.researchFailed}`);

    // 7. Cache to DB
    const researchJson = result.research ? JSON.stringify(result.research) : null;
    await pool.query(
      `INSERT INTO cover_letters (job_id, cover_letter_text, research_context) VALUES ($1, $2, $3)`,
      [jobId, result.coverLetter, researchJson]
    );
    // Keep only the 3 most recent per job to avoid unbounded growth
    await pool.query(
      `DELETE FROM cover_letters WHERE job_id=$1 AND id NOT IN (SELECT id FROM cover_letters WHERE job_id=$1 ORDER BY created_at DESC LIMIT 3)`,
      [jobId]
    );

    res.json({
      cover_letter: result.coverLetter,
      research: result.research,
      research_failed: result.researchFailed,
      model: documentModel,
      cached: false,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[CoverLetter] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Resume Tailoring V2 (job-specific, 3-step Claude) ─────────────────────
// POST /api/jobs/:id/tailor-resume   (force=true to bypass cache)
app.post('/api/jobs/:id/tailor-resume', async (req: Request, res: Response) => {
  try {
    const jobId = Number(req.params.id);
    const force = req.query.force === 'true' || req.body?.force === true;

    // 1. Load job
    const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (jobRows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = jobRows[0] as any;

    // 2. Check cache
    if (!force) {
      const { rows: cached } = await pool.query(
        'SELECT * FROM tailored_resumes WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1', [jobId]
      );
      if (cached.length > 0) {
        const c = cached[0] as any;
        let atsResearch = null; let gapAnalysis = null;
        try { if (c.ats_research) atsResearch = JSON.parse(c.ats_research); } catch { /* ignore */ }
        try { if (c.gap_analysis) gapAnalysis = JSON.parse(c.gap_analysis); } catch { /* ignore */ }
        res.json({ resume_text: c.resume_text, ats_research: atsResearch, gap_analysis: gapAnalysis, cached: true, created_at: c.created_at });
        return;
      }
    }

    // 3. Load resume
    const { rows: resumeRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
    const resumeText: string = resumeRows[0]?.value ?? '';
    if (!resumeText.trim()) {
      res.status(400).json({ error: 'NO_RESUME', message: 'Please add your resume on the Resume page before tailoring.' });
      return;
    }

    // 4. Load company research brief (fresh < 48h)
    const { rows: briefRows } = await pool.query(
      `SELECT brief_json FROM research_briefs WHERE LOWER(company_name)=LOWER($1) AND status='ready' AND created_at > NOW() - INTERVAL '48 hours' ORDER BY created_at DESC LIMIT 1`,
      [job.company]
    );
    let companyResearchContext: string | null = null;
    if (briefRows.length > 0) {
      try {
        const brief = briefRows[0].brief_json as any;
        const parts: string[] = [];
        if (brief.companyMoment) parts.push(`Company moment: ${brief.companyMoment}`);
        if (brief.productContext) parts.push(`Products: ${brief.productContext}`);
        if (brief.marketPosition) parts.push(`Market position: ${brief.marketPosition}`);
        companyResearchContext = parts.join('\n');
      } catch { /* ignore */ }
    }

    // 5. Load document model preference + resume_tailor system prompt from DB
    const { rows: dmRows2 } = await pool.query("SELECT value FROM settings WHERE key='document_model'");
    const documentModel2: string = dmRows2[0]?.value || 'claude-opus-4-6';
    const { rows: resumePromptRows } = await pool.query(
      "SELECT prompt_text FROM system_prompts WHERE prompt_name='resume_tailor'"
    );
    const resumeSystemPrompt: string | null = resumePromptRows[0]?.prompt_text ?? null;

    // 6. Territory detection + analysis (non-fatal)
    const detectedTerritory2 = detectTerritory(job.title, job.description ?? '');
    let territoryCtx2 = null;
    if (detectedTerritory2) {
      console.log(`[TailorV2] Territory detected: "${detectedTerritory2}" — running territory intelligence`);
      territoryCtx2 = await analyzeTerritoryContext(job.title, job.company, detectedTerritory2, resumeText);
    }

    // 7. Three-step tailoring
    console.log(`[TailorV2] Endpoint: job #${jobId} (${job.title} @ ${job.company}), force=${force}, model=${documentModel2}`);
    const result = await tailorResumeV2WithClaude({
      jobTitle: job.title,
      companyName: job.company,
      jobDescription: job.description ?? '',
      resumeText,
      companyResearchContext,
      model: documentModel2,
      territoryContext: territoryCtx2,
      resumeSystemPrompt,
    });

    // 7. Cache (keep 3 most recent per job)
    await pool.query(
      `INSERT INTO tailored_resumes (job_id, resume_text, ats_keywords, gap_analysis, ats_research) VALUES ($1,$2,$3,$4,$5)`,
      [
        jobId,
        result.resumeText,
        result.atsResearch.mustHaveKeywords,
        JSON.stringify(result.gapAnalysis),
        JSON.stringify(result.atsResearch),
      ]
    );
    await pool.query(
      `DELETE FROM tailored_resumes WHERE job_id=$1 AND id NOT IN (SELECT id FROM tailored_resumes WHERE job_id=$1 ORDER BY created_at DESC LIMIT 3)`,
      [jobId]
    );

    res.json({
      resume_text: result.resumeText,
      ats_research: result.atsResearch,
      gap_analysis: result.gapAnalysis,
      research_failed: result.researchFailed,
      model: documentModel2,
      cached: false,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[TailorV2] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Targeted company scan (Career Intel / Pre-IPO → open roles) ───────────
// POST /api/jobs/targeted-scan
// Body: { companies: string[], source: 'intel' | 'preipo' }
// Runs Gemini discovery scoped to the listed companies, scores with Claude,
// saves matches to DB, and returns the scored jobs for display.
app.post('/api/jobs/targeted-scan', async (req: Request, res: Response) => {
  try {
    const { companies, source } = req.body as { companies?: string[]; source?: string };
    if (!companies || !Array.isArray(companies) || companies.length === 0) {
      res.status(400).json({ error: 'companies array is required' });
      return;
    }

    const companyNames = companies.map((c: string) => c.trim()).filter(Boolean).slice(0, 20);
    const scanSource = source === 'preipo' ? 'preipo-scan' : 'intel-scan';

    console.log(`\n──── TARGETED SCAN (${scanSource}) ────────────────────────────────`);
    console.log(`Companies (${companyNames.length}): ${companyNames.join(', ')}`);

    // Load criteria
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    const criteria = cRows[0] as any ?? {};
    const { rows: resumeRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
    const candidateResume: string = resumeRows[0]?.value ?? '';

    const geminiCriteria = {
      target_roles:  criteria.target_roles  ?? [],
      locations:     criteria.locations     ?? ['Remote'],
      work_type:     criteria.work_type     ?? 'any',
      must_have:     criteria.must_have     ?? [],
      nice_to_have:  criteria.nice_to_have  ?? [],
      avoid:         criteria.avoid         ?? [],
      industries:    criteria.industries    ?? [],
      min_salary:    criteria.min_salary    ?? null,
      company_focus: companyNames,
    };

    // Run Gemini with company-focused prompt
    console.log('[TargetedScan] Calling Gemini discovery…');
    const geminiResult = await runGeminiJobDiscovery(geminiCriteria);

    if (geminiResult.skipped) {
      console.log(`[TargetedScan] Gemini skipped: ${geminiResult.skipReason}`);
      res.json({ jobs: [], skipped: true, skip_reason: geminiResult.skipReason });
      return;
    }

    console.log(`[TargetedScan] Gemini returned ${geminiResult.jobs.length} raw jobs`);

    // Deduplicate against existing jobs in DB
    const { rows: existingRows } = await pool.query('SELECT apply_url FROM jobs');
    const seenUrls = new Set(existingRows.map((r: any) => r.apply_url as string));
    const newJobs = geminiResult.jobs.filter(j => !seenUrls.has(j.applyUrl));
    console.log(`[TargetedScan] ${newJobs.length} new (${geminiResult.jobs.length - newJobs.length} already in DB)`);

    if (newJobs.length === 0 && geminiResult.jobs.length === 0) {
      res.json({ jobs: [], count: 0 });
      return;
    }

    // Score with Claude (use all Gemini results, even if URL already in DB — we still return them)
    const toScore = geminiResult.jobs.slice(0, 25);
    const { rows: tierRows } = await pool.query("SELECT value FROM settings WHERE key='tier_settings'");
    const tierSettings = tierRows[0]?.value ? JSON.parse(tierRows[0].value) : {};

    console.log(`[TargetedScan] Scoring ${toScore.length} jobs with Claude…`);
    const matches = await scoreJobsWithClaude(
      toScore.map(j => ({ title: j.title, company: j.company, location: j.location, salary: j.salary, applyUrl: j.applyUrl, description: j.description })),
      {
        targetRoles:        criteria.target_roles       ?? [],
        industries:         criteria.industries         ?? [],
        minSalary:          criteria.min_salary         ?? null,
        minOte:             criteria.min_ote            ?? null,
        locations:          criteria.locations          ?? ['Remote'],
        allowedWorkModes:   criteria.allowed_work_modes ?? [],
        mustHave:           criteria.must_have          ?? [],
        niceToHave:         criteria.nice_to_have       ?? [],
        avoid:              criteria.avoid              ?? [],
        preApprovedCompanies: companyNames,
        tierSettings,
        candidateResume: candidateResume || undefined,
        acceptedExperienceLevels: criteria.experience_levels ?? ['senior'],
      }
    );

    console.log(`[TargetedScan] Claude returned ${matches.length} scored matches`);

    // Save new (not-yet-in-DB) matches to the jobs table
    const allowedWorkModes: string[] = criteria.allowed_work_modes ?? [];
    let saved = 0;
    for (const m of matches) {
      if (!seenUrls.has(m.applyUrl)) {
        const loc = (m.location ?? '').trim();
        const locationOk = checkJobLocation(loc, criteria.locations ?? [], false, allowedWorkModes);
        const finalTier = !locationOk
          ? 'Probably Skip'
          : (m.subScores && m.matchScore)
            ? computeTier(m.matchScore, m.aiRisk, m.subScores, m.title, m.company, loc, tierSettings)
            : (m.opportunityTier ?? 'unscored');

        try {
          await pool.query(
            `INSERT INTO jobs (title, company, location, salary, apply_url, why_good_fit, match_score, source, is_hardware, ai_risk, ai_risk_score, ai_risk_reason, opportunity_tier, sub_scores)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
             ON CONFLICT (apply_url) DO NOTHING`,
            [m.title, m.company, m.location, m.salary ?? null, m.applyUrl, m.whyGoodFit, m.matchScore, scanSource, m.isHardware ?? false, m.aiRisk ?? 'unknown', m.aiRiskScore ?? null, m.aiRiskReason ?? null, finalTier, JSON.stringify(m.subScores ?? null)]
          );
          saved++;
        } catch (_e) { /* ignore individual insert errors */ }
      }
    }
    console.log(`[TargetedScan] Saved ${saved} new jobs to DB`);
    console.log(`───────────────────────────────────────────────────────────`);

    // Return scored matches for immediate display
    res.json({
      jobs: matches.map(m => ({
        id: null,
        title: m.title,
        company: m.company,
        location: m.location,
        salary: m.salary,
        apply_url: m.applyUrl,
        why_good_fit: m.whyGoodFit,
        match_score: m.matchScore,
        opportunity_tier: m.opportunityTier,
        ai_risk: m.aiRisk,
        source: scanSource,
      })),
      count: matches.length,
      saved,
      model_used: geminiResult.modelUsed,
    });
  } catch (e) {
    console.error('[TargetedScan] Error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ── Auto-run status endpoint ───────────────────────────────────────────────
app.get('/api/scout/auto-status', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(
      "SELECT started_at FROM scout_runs WHERE status='completed' ORDER BY started_at DESC LIMIT 1"
    );
    const lastRun = rows[0]?.started_at ? new Date(rows[0].started_at) : null;
    const hoursSince = lastRun ? (Date.now() - lastRun.getTime()) / 3_600_000 : null;
    const nextRunInH = hoursSince != null ? Math.max(0, AUTO_RUN_THRESHOLD_H - hoursSince) : 0;
    res.json({
      last_run: lastRun,
      next_run_in_hours: Math.round(nextRunInH * 10) / 10,
      threshold_hours: AUTO_RUN_THRESHOLD_H,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Opportunity Rescore — backfill sub-scores and tiers for existing jobs
let rescoreRunning = false;

app.get('/api/jobs/rescore-status', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN opportunity_tier='unscored' THEN 1 ELSE 0 END) as unscored FROM jobs`);
    res.json({ running: rescoreRunning, total: Number(rows[0].total), unscored: Number(rows[0].unscored) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/jobs/rescore-all', async (req, res: Response) => {
  if (rescoreRunning) { res.json({ started: false, message: 'Rescore already running' }); return; }
  try {
    const forceRescore = req.query.force === 'true' || (req.body as any)?.force === true;
    // In force mode, rescore all jobs that have descriptions (descriptions may have been enriched since last score)
    const jobQuery = forceRescore
      ? `SELECT * FROM jobs WHERE description IS NOT NULL AND LENGTH(description) >= 50 ORDER BY match_score DESC NULLS LAST`
      : `SELECT * FROM jobs WHERE opportunity_tier='unscored' ORDER BY found_at DESC`;
    const { rows: unscored } = await pool.query(jobQuery);
    if (unscored.length === 0) { res.json({ started: false, message: forceRescore ? 'No jobs with descriptions found' : 'All jobs already scored', count: 0 }); return; }
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    if (cRows.length === 0) { res.status(400).json({ error: 'No criteria configured' }); return; }
    const criteria = cRows[0] as any;
    const { rows: companyRows } = await pool.query('SELECT name FROM companies');
    const companyNames = companyRows.map((r: any) => r.name as string);
    const { rows: resumeRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
    const candidateResume: string = resumeRows[0]?.value ?? '';
    const rescorerTierSettings: TierSettings = {
      verticalNiches: criteria.vertical_niches ?? [],
      topTargetScore: criteria.top_target_score ?? 65,
      fastWinScore: criteria.fast_win_score ?? 55,
      stretchScore: criteria.stretch_score ?? 55,
      experienceLevels: criteria.experience_levels ?? ['senior'],
    };
    const criteriaText = [
      criteria.target_roles?.length ? `Target roles: ${criteria.target_roles.join(', ')}` : '',
      criteria.industries?.length ? `Target industries: ${criteria.industries.join(', ')}` : '',
      criteria.locations?.length ? `Preferred locations: ${criteria.locations.join(', ')}` : '',
      (() => {
        const modes: string[] = criteria.allowed_work_modes ?? [];
        const parts: string[] = [];
        if (modes.includes('remote_us')) parts.push('true remote (US-wide, no city restriction)');
        if (modes.includes('remote_in_territory')) parts.push('remote-in-territory (must live near specified city)');
        if (modes.includes('onsite')) parts.push('on-site physical office');
        return parts.length > 0 ? `Accepted work modes: ${parts.join(', ')}` : '';
      })(),
      criteria.must_have?.length ? `Must have: ${criteria.must_have.join(', ')}` : '',
      criteria.nice_to_have?.length ? `Nice to have: ${criteria.nice_to_have.join(', ')}` : '',
      criteria.avoid?.length ? `Avoid (automatic disqualifier): ${criteria.avoid.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const preApprovedSection = companyNames.length > 0
      ? `PRE-APPROVED COMPANIES:\nThe user has manually vetted and approved these employers as targets.\nPre-approved companies: ${companyNames.join(', ')}`
      : '';
    res.json({ started: true, count: unscored.length });
    rescoreRunning = true;
    // Run in background
    (async () => {
      console.log(`\n──── OPPORTUNITY RESCORE — ${unscored.length} jobs ─────────────`);
      let done = 0;
      for (let i = 0; i < unscored.length; i += 8) {
        const batch = unscored.slice(i, i + 8);
        await Promise.allSettled(batch.map(async (j: any) => {
          try {
            const result = await rescoreJobOpportunity(
              { id: j.id, title: j.title, company: j.company, location: j.location, salary: j.salary, applyUrl: j.apply_url, description: j.description },
              criteriaText, preApprovedSection, companyNames, rescorerTierSettings,
              criteria.min_salary ?? null, candidateResume || undefined, criteria.min_ote ?? null,
            );
            if (result) {
              await pool.query(
                `UPDATE jobs SET opportunity_tier=$1, sub_scores=$2, ai_risk=$3, ai_risk_score=$4, ai_risk_reason=$5, why_good_fit=$6, match_score=$7 WHERE id=$8`,
                [result.opportunityTier, JSON.stringify(result.subScores), result.aiRisk, result.aiRiskScore ?? null, result.aiRiskReason, result.whyGoodFit, result.matchScore, j.id]
              );
            } else {
              await pool.query(`UPDATE jobs SET opportunity_tier='Probably Skip' WHERE id=$1`, [j.id]);
            }
            done++;
          } catch (e) { console.error(`Rescore error for job ${j.id}:`, e); done++; }
        }));
        console.log(`  Rescored ${Math.min(i + 8, unscored.length)}/${unscored.length}`);
      }
      console.log(`──── RESCORE COMPLETE — ${done} jobs scored ─────────────────`);
      rescoreRunning = false;
    })();
  } catch (e) { rescoreRunning = false; res.status(500).json({ error: String(e) }); }
});

// ── Local reclassify — re-applies title filter + computeTier to all jobs ──
// No Claude calls, instant, safe to run on every startup or after settings change.
async function reclassifyJobsLocally(): Promise<number> {
  const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
  const criteria = cRows[0] ?? {};
  const userLocations: string[] = criteria.locations ?? [];
  const allowedWorkModes: string[] = criteria.allowed_work_modes ?? [];
  const targetRoles: string[] = criteria.target_roles ?? [];
  const avoidKeywords: string[] = (criteria.avoid ?? []).filter((k: string) => k.trim().length > 0);
  const tierSettings: TierSettings = {
    verticalNiches: criteria.vertical_niches ?? [],
    topTargetScore: criteria.top_target_score ?? 65,
    fastWinScore: criteria.fast_win_score ?? 55,
    stretchScore: criteria.stretch_score ?? 55,
    experienceLevels: criteria.experience_levels ?? ['senior'],
  };

  // Build title filter from current settings
  const titleFilter = buildTitleFilter(targetRoles);
  const avoidPatterns = avoidKeywords.map((k: string) =>
    new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
  );

  const minSalary: number | null = criteria.min_salary ?? null;
  const minOte: number | null    = criteria.min_ote    ?? null;

  // Segment filter — same logic used in the scout pipeline pre-filter
  const _userRolesLower = targetRoles.map((r: string) => r.toLowerCase());
  const _wantsCommercial = _userRolesLower.some((r: string) => /commercial|mid.?market|smb|small.?biz/i.test(r));
  const _SEGMENT_EXCLUDE = /\b(commercial|mid[\s-]market|smb|small\s+business|small\s+&\s+medium)\b/i;
  const _SEGMENT_ROLE_CTX = /(account|sales|ae\b|rep\b)/i;
  function _isExcludedSegment(title: string): boolean {
    if (_wantsCommercial) return false;
    if (!_SEGMENT_EXCLUDE.test(title)) return false;
    return _SEGMENT_ROLE_CTX.test(title);
  }

  // Territory filter — same logic used in the scout pipeline pre-filter
  const _userLocLower = (userLocations).map((l: string) => l.toLowerCase());
  const _isSEUser = _userLocLower.some((l: string) => /south.?carolina|north.?carolina|georgia|florida|southeast|se\b/.test(l));
  const _TERRITORY_EXCLUDE = /\b(northeast|new\s+england|mid[\s-]atlantic|midwest|great\s+lakes|north\s+central|northwest|pacific\s+northwest|pnw|west\s+coast|southwest|tola|mountain\s+west|rocky\s+mountain|plains|upper\s+midwest)\b/i;
  const _TERRITORY_SE_OK   = /\b(southeast|southern|carolinas?|florida|georgia|sc\b|nc\b|fl\b|ga\b)\b/i;
  function _isExcludedTerritory(title: string): boolean {
    if (!_isSEUser) return false;
    if (!_TERRITORY_EXCLUDE.test(title)) return false;
    if (_TERRITORY_SE_OK.test(title)) return false;
    return true;
  }

  // Fetch all jobs (scored or not)
  const { rows } = await pool.query(`
    SELECT id, title, company, location, salary, match_score, ai_risk, ai_risk_score, sub_scores, opportunity_tier
    FROM jobs
  `);

  // Helper: parse salary string into {base, ote} where each may be null if not detected
  function parseSalaryFigures(salaryStr: string): { base: number | null; ote: number | null } {
    if (!salaryStr) return { base: null, ote: null };
    const lower = salaryStr.toLowerCase();
    // Detect whether the string explicitly mentions OTE / total / on-target
    const isOteString = /\bote\b|\btotal\b|\bon.?target\b|\btake.?home\b/i.test(lower);
    const nums = salaryStr.match(/[\d,]+/g);
    if (!nums) return { base: null, ote: null };
    const parsed = nums.map((n) => parseInt(n.replace(/,/g, ''), 10)).filter(n => !isNaN(n) && n >= 1000);
    if (!parsed.length) return { base: null, ote: null };
    // If the string looks like a range "120,000 - 180,000 OTE", use the highest as the OTE
    const highest = Math.max(...parsed);
    const lowest  = Math.min(...parsed);
    if (isOteString) return { base: lowest > 50000 ? lowest : null, ote: highest };
    // No explicit OTE marker — treat as base salary
    return { base: highest, ote: null };
  }

  // Helper: returns true only when the salary is DEFINITIVELY known to fail BOTH constraints
  function salaryKnownBelow(salaryStr: string | null | undefined): boolean {
    if (!salaryStr) return false;
    if (!minSalary && !minOte) return false;
    const { base, ote } = parseSalaryFigures(salaryStr);
    // Pass if base meets minimum base requirement
    if (minSalary && base !== null && base >= minSalary) return false;
    // Pass if OTE meets minimum OTE requirement
    if (minOte && ote !== null && ote >= minOte) return false;
    // Fail ONLY if there's a definitive figure that's below the relevant minimum
    const hasDefinitiveFigure = base !== null || ote !== null;
    if (!hasDefinitiveFigure) return false; // no info → don't gate
    // Check each available figure against its minimum
    if (minSalary && base !== null && base < minSalary && !ote) return true;
    if (minOte    && ote  !== null && ote  < minOte    && !base) return true;
    // Both figures present: only fail if BOTH are below their respective minimums
    if (base !== null && ote !== null) {
      const baseFails = minSalary ? base < minSalary : false;
      const oteFails  = minOte    ? ote  < minOte    : false;
      return baseFails && oteFails;
    }
    return false;
  }

  let updated = 0;
  for (const j of rows) {
    try {
      const loc = (j.location ?? '').trim();
      let tier: OpportunityTier;

      // Hard filter 1: title must match target roles filter
      const titleMatches = !titleFilter || titleFilter.test(j.title ?? '');

      // Hard filter 2: avoid keywords
      const hasAvoid = avoidPatterns.some(p => p.test(j.title ?? ''));

      // Hard filter 3: location
      const locationOk = userLocations.length === 0 || checkJobLocation(loc, userLocations, false, allowedWorkModes);

      // Hard filter 4: salary (only when salary is EXPLICITLY listed AND known below min)
      const belowSalary = salaryKnownBelow(j.salary);

      // Hard filter 5: territory mismatch only (segment is NOT a hard block — comp handles it)
      const badTerritory = _isExcludedTerritory(j.title ?? '');

      if (!titleMatches || hasAvoid || !locationOk || belowSalary || badTerritory) {
        tier = 'Probably Skip';
      } else if (j.sub_scores && j.match_score !== null) {
        const s: SubScores = typeof j.sub_scores === 'string' ? JSON.parse(j.sub_scores) : j.sub_scores;
        const _aiRiskForTier = j.ai_risk_score != null
          ? (Number(j.ai_risk_score) >= 7 ? 'HIGH' : Number(j.ai_risk_score) >= 4 ? 'MEDIUM' : 'LOW')
          : (j.ai_risk ?? 'unknown');
        tier = computeTier(j.match_score, _aiRiskForTier, s, j.title, j.company, loc, tierSettings);
      } else {
        tier = j.opportunity_tier as OpportunityTier;
      }

      if (tier !== j.opportunity_tier) {
        await pool.query(`UPDATE jobs SET opportunity_tier=$1 WHERE id=$2`, [tier, j.id]);
        updated++;
      }
    } catch { /* skip malformed rows */ }
  }
  return updated;
}

app.post('/api/jobs/reclassify-local', async (_req, res: Response) => {
  try {
    const count = await reclassifyJobsLocally();
    console.log(`Local reclassify complete: ${count} jobs updated`);
    res.json({ updated: count });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Scout runs
app.get('/api/scout/status', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM scout_runs ORDER BY started_at DESC LIMIT 20');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

let scoutRunning = false;

app.post('/api/scout/run', async (_req, res: Response) => {
  if (scoutRunning) {
    res.status(409).json({ error: 'A scout run is already in progress.' });
    return;
  }
  try {
    const { rows } = await pool.query(
      "INSERT INTO scout_runs (status, jobs_found) VALUES ('running', 0) RETURNING *"
    );
    const run = rows[0];
    res.json({ runId: run.id, message: 'Scout run started' });
    scoutRunning = true;
    runScoutInBackground(run.id).catch(console.error).finally(() => { scoutRunning = false; });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Settings (resume, schedule, etc.)
app.get('/api/settings/:key', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT value FROM settings WHERE key=$1', [req.params.key]);
    res.json({ value: rows[0]?.value ?? '' });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put('/api/settings/:key', async (req: Request, res: Response) => {
  try {
    const { value } = req.body;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value=$2`,
      [req.params.key, value ?? '']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Resume
app.get('/api/resume', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query("SELECT key, value FROM settings WHERE key IN ('resume', 'resume_html')");
    const byKey: Record<string, string> = {};
    rows.forEach((r: any) => { byKey[r.key] = r.value; });
    res.json({ resume: byKey['resume'] ?? '', resume_html: byKey['resume_html'] ?? '' });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put('/api/resume', async (req: Request, res: Response) => {
  try {
    const { resume, resume_html } = req.body;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('resume', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [resume ?? '']
    );
    if (resume_html !== undefined) {
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('resume_html', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
        [resume_html ?? '']
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Saved resumes — list
app.get('/api/resumes', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT id, name, content_html, LEFT(content, 120) AS preview, created_at FROM saved_resumes ORDER BY created_at DESC');
    const { rows: active } = await pool.query("SELECT value FROM settings WHERE key='active_resume_id'");
    res.json({ resumes: rows, activeId: active[0]?.value ? Number(active[0].value) : null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Saved resumes — get one (full content)
app.get('/api/resumes/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM saved_resumes WHERE id=$1', [Number(req.params.id)]);
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Saved resumes — create / rename
app.post('/api/resumes', async (req: Request, res: Response) => {
  try {
    const { name, content, content_html } = req.body;
    if (!name || !content) { res.status(400).json({ error: 'name and content required' }); return; }
    const { rows } = await pool.query(
      'INSERT INTO saved_resumes (name, content, content_html) VALUES ($1, $2, $3) RETURNING *',
      [name, content, content_html ?? '']
    );
    res.json({ ok: true, resume: rows[0] });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Saved resumes — delete
app.delete('/api/resumes/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM saved_resumes WHERE id=$1', [Number(req.params.id)]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Saved resumes — activate (loads content into active settings resume)
app.post('/api/resumes/:id/activate', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM saved_resumes WHERE id=$1', [Number(req.params.id)]);
    if (!rows.length) { res.status(404).json({ error: 'Not found' }); return; }
    const r = rows[0];
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('resume', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [r.content]
    );
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('resume_html', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [r.content_html ?? '']
    );
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('active_resume_id', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [String(r.id)]
    );
    res.json({ ok: true, resume: r });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Sanitize mammoth HTML output — keep semantic tags, strip dangerous attributes
function sanitizeMammothHtml(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/ on\w+="[^"]*"/gi, '')
    .replace(/ style="[^"]*"/gi, '');
}

// Resume file upload (PDF or DOCX) — extracts text and stores HTML for display
app.post('/api/resume/upload', upload.single('file'), async (req: Request, res: Response) => {
  try {
    const mreq = req as any;
    if (!mreq.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    const { mimetype, buffer, originalname } = mreq.file as { mimetype: string; buffer: Buffer; originalname: string };
    let text = '';
    let html = ''; // rich HTML for display (DOCX only; PDF/text uses client-side converter)
    if (mimetype === 'application/pdf' || originalname.toLowerCase().endsWith('.pdf')) {
      const parsed = await pdfParse(buffer);
      text = parsed.text;
      // html left empty — client generates via textToResumeHtml()
    } else if (
      mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      originalname.toLowerCase().endsWith('.docx')
    ) {
      const [rawResult, htmlResult] = await Promise.all([
        mammoth.extractRawText({ buffer }),
        mammoth.convertToHtml({ buffer }),
      ]);
      text = rawResult.value;
      html = sanitizeMammothHtml(htmlResult.value);
    } else {
      res.status(400).json({ error: 'Unsupported file type. Upload a PDF or Word (.docx) file.' });
      return;
    }
    // Clean up extracted text
    text = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

    // Auto-save to settings (active resume + html)
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('resume', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [text]
    );
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('resume_html', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [html]
    );
    // Save as named resume using the filename (strip extension)
    const resumeName = originalname.replace(/\.[^.]+$/, '');
    const { rows: inserted } = await pool.query(
      `INSERT INTO saved_resumes (name, content, content_html) VALUES ($1, $2, $3) RETURNING id`,
      [resumeName, text, html]
    );
    const newId = inserted[0].id;
    // Mark as active
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('active_resume_id', $1) ON CONFLICT (key) DO UPDATE SET value=$1`,
      [String(newId)]
    );

    res.json({ ok: true, text, html, savedId: newId, savedName: resumeName });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Word document generation helpers ─────────────────────────────────────

/** Parse inline markdown (bold/italic) into TextRun array */
function parseInline(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // Match **bold**, *italic*, or plain text segments
  const re = /[*][*]([^*]+)[*][*]|[*]([^*]+)[*]|([^*]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) runs.push(new TextRun({ text: m[1], bold: true }));
    else if (m[2] !== undefined) runs.push(new TextRun({ text: m[2], italics: true }));
    else if (m[3] !== undefined) runs.push(new TextRun({ text: m[3] }));
  }
  return runs.length ? runs : [new TextRun({ text })];
}

/** Convert Markdown text to a .docx Buffer */
async function markdownToDocx(md: string): Promise<Buffer> {
  const lines = md.split('\n');
  const children: Paragraph[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (/^# /.test(line)) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: parseInline(line.slice(2).trim()),
        spacing: { after: 80 },
      }));
    } else if (/^## /.test(line)) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        children: parseInline(line.slice(3).trim()),
        spacing: { before: 240, after: 60 },
        border: { bottom: { style: 'single', size: 4, color: '666666', space: 4 } },
      }));
    } else if (/^### /.test(line)) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_3,
        children: parseInline(line.slice(4).trim()),
        spacing: { before: 160, after: 40 },
      }));
    } else if (/^- /.test(line)) {
      children.push(new Paragraph({
        bullet: { level: 0 },
        children: parseInline(line.slice(2).trim()),
        spacing: { after: 40 },
      }));
    } else if (line.trim() === '') {
      children.push(new Paragraph({ children: [new TextRun({ text: '' })], spacing: { after: 80 } }));
    } else {
      children.push(new Paragraph({
        children: parseInline(line.trim()),
        spacing: { after: 80 },
      }));
    }
  }

  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: 'Calibri', size: 22 }, // 11pt
        },
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}

// Download tailored document as Word
app.post('/api/download-docx', async (req: Request, res: Response) => {
  try {
    const { text, filename } = req.body as { text: string; filename?: string };
    if (!text) { res.status(400).json({ error: 'text is required' }); return; }
    const buf = await markdownToDocx(text);
    const name = (filename || 'document').replace(/[^a-zA-Z0-9_-]/g, '_') + '.docx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.end(buf);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Resume tailoring
app.post('/api/tailor/:jobId', async (req: Request, res: Response) => {
  try {
    const jobId = Number(req.params.jobId);
    const targetPages = (req.body?.targetPages === 1 || req.body?.targetPages === 2)
      ? req.body.targetPages as 1 | 2 : undefined;
    const force = req.body?.force === true;

    // Return cached doc unless force-refresh or targetPages explicitly set
    if (!force && targetPages === undefined) {
      const { rows: existing } = await pool.query(
        'SELECT * FROM tailored_docs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1', [jobId]
      );
      if (existing.length > 0) {
        res.json({ ...existing[0], cached: true });
        return;
      }
    }

    // Get job details
    const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (jobRows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = jobRows[0];
    // Get resume and model preference
    const { rows: resRows } = await pool.query("SELECT key, value FROM settings WHERE key IN ('resume', 'tailor_model')");
    const byKey: Record<string, string> = {};
    resRows.forEach((r: { key: string; value: string }) => { byKey[r.key] = r.value; });
    const resume = byKey['resume'] ?? '';
    if (!resume) { res.status(400).json({ error: 'No base resume saved. Please save your resume first.' }); return; }
    const tailorModel = byKey['tailor_model'] || 'claude-sonnet-4-5';

    const result = await tailorResumeWithClaude(job, resume, { targetPages, model: tailorModel });
    const { rows: inserted } = await pool.query(
      `INSERT INTO tailored_docs (job_id, resume_text, cover_letter) VALUES ($1, $2, $3) RETURNING *`,
      [jobId, result.resume, result.coverLetter]
    );
    res.json({ ...inserted[0], analysis: result.analysis, suggested_edits: result.suggestedEdits ?? '' });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Freeform resume tailoring (from pasted job description)
app.post('/api/tailor-freeform', async (req: Request, res: Response) => {
  try {
    const { resume, jobDescription, targetPages } = req.body as {
      resume: string; jobDescription: string; targetPages?: 1 | 2;
    };
    if (!resume || !jobDescription) {
      res.status(400).json({ error: 'Both resume and job description are required.' });
      return;
    }
    const fakeJob = {
      title: 'Target Role',
      company: 'Target Company',
      location: '',
      description: jobDescription,
    };
    const { rows: modelRows } = await pool.query("SELECT value FROM settings WHERE key='tailor_model'");
    const tailorModel = modelRows[0]?.value || 'claude-sonnet-4-5';
    const result = await tailorResumeWithClaude(fakeJob, resume, { targetPages, model: tailorModel });
    res.json({ resume_text: result.resume, cover_letter: result.coverLetter, suggested_edits: result.suggestedEdits ?? '', analysis: result.analysis });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Company Research ──────────────────────────────────────────────────────
app.post('/api/jobs/:id/research', async (req: Request, res: Response) => {
  try {
    const jobId = Number(req.params.id);
    const forceRefresh = req.body?.refresh === true;

    // Get job record
    const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (jobRows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = jobRows[0];
    const companyName = job.company;

    // Check cache (case-insensitive, < 24 hours old, completed)
    if (!forceRefresh) {
      const { rows: cached } = await pool.query(
        `SELECT * FROM research_briefs WHERE LOWER(company_name) = LOWER($1) AND created_at > NOW() - INTERVAL '24 hours' AND status = 'ready' ORDER BY created_at DESC LIMIT 1`,
        [companyName]
      );
      if (cached.length > 0) {
        const { rows: coRows } = await pool.query(
          `SELECT careers_url FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1`,
          [companyName]
        );
        res.json({ brief: cached[0].brief_json, cached: true, created_at: cached[0].created_at, careers_url: coRows[0]?.careers_url || null, id: cached[0].id, saved: cached[0].saved, status: 'ready' });
        return;
      }

      // Check if already processing
      const { rows: processing } = await pool.query(
        `SELECT * FROM research_briefs WHERE LOWER(company_name) = LOWER($1) AND status = 'processing' AND created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1`,
        [companyName]
      );
      if (processing.length > 0) {
        res.json({ status: 'processing', id: processing[0].id });
        return;
      }
    }

    // Create a placeholder row with 'processing' status, return immediately
    const { rows: placeholder } = await pool.query(
      `INSERT INTO research_briefs (company_name, brief_json, status) VALUES ($1, '{}', 'processing') RETURNING *`,
      [companyName]
    );
    const briefId = placeholder[0].id;

    // Return immediately so Replit proxy doesn't timeout
    res.json({ status: 'processing', id: briefId });

    // Run research in background (fire-and-forget)
    (async () => {
      try {
        const brief = await researchCompanyWithClaude(companyName);
        await pool.query(
          `UPDATE research_briefs SET brief_json = $1, status = 'ready' WHERE id = $2`,
          [JSON.stringify(brief), briefId]
        );
        console.log(`Research complete for ${companyName} (id=${briefId})`);
      } catch (e) {
        console.error(`Research failed for ${companyName}:`, e);
        await pool.query(
          `UPDATE research_briefs SET status = 'error', error = $1 WHERE id = $2`,
          [String(e), briefId]
        ).catch(() => {});
      }
    })();
  } catch (e) {
    console.error('Research company error:', e);
    res.status(500).json({ error: String(e) });
  }
});

// Poll for research status
app.get('/api/research/status/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query('SELECT * FROM research_briefs WHERE id = $1', [id]);
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    const row = rows[0];

    if (row.status === 'ready') {
      const { rows: coRows } = await pool.query(
        `SELECT careers_url FROM companies WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [row.company_name]
      );
      res.json({ status: 'ready', brief: row.brief_json, cached: false, created_at: row.created_at, careers_url: coRows[0]?.careers_url || null, id: row.id, saved: row.saved });
    } else if (row.status === 'error') {
      res.json({ status: 'error', error: row.error });
    } else {
      res.json({ status: 'processing', id: row.id });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Get all saved research briefs
app.get('/api/research', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM research_briefs WHERE saved = true ORDER BY created_at DESC'
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Save a research brief permanently
app.post('/api/research/:id/save', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      'UPDATE research_briefs SET saved = true WHERE id = $1 RETURNING *',
      [id]
    );
    if (rows.length === 0) { res.status(404).json({ error: 'Brief not found' }); return; }
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Unsave / delete a saved research brief
app.delete('/api/research/:id', async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    await pool.query('DELETE FROM research_briefs WHERE id = $1', [id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Salary Estimates ─────────────────────────────────────────────────────
app.get('/api/salary-estimate', async (req: Request, res: Response) => {
  try {
    const title = String(req.query.title || '');
    const company = String(req.query.company || '');
    if (!title || !company) { res.json({ estimate: null }); return; }

    // Check cache (7-day validity)
    const { rows: cached } = await pool.query(
      `SELECT * FROM salary_estimates WHERE LOWER(job_title) = LOWER($1) AND LOWER(company_name) = LOWER($2) AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 1`,
      [title, company]
    );
    if (cached.length > 0) {
      res.json({ estimate: cached[0].estimate_json, cached: true });
      return;
    }
    res.json({ estimate: null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Batch salary estimates for multiple jobs
app.post('/api/salary-estimates/batch', async (req: Request, res: Response) => {
  try {
    const jobIds: number[] = req.body?.jobIds || [];
    if (!jobIds.length) { res.json({}); return; }

    // Get jobs info
    const { rows: jobs } = await pool.query(
      `SELECT id, title, company, salary FROM jobs WHERE id = ANY($1)`,
      [jobIds]
    );

    const result: Record<number, unknown> = {};
    for (const job of jobs) {
      const { rows: cached } = await pool.query(
        `SELECT estimate_json FROM salary_estimates WHERE LOWER(job_title) = LOWER($1) AND LOWER(company_name) = LOWER($2) AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 1`,
        [job.title, job.company]
      );
      if (cached.length > 0) {
        result[job.id] = cached[0].estimate_json;
      }
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── RepVue (link-out only) ───────────────────────────────────────────────

// Gmail OAuth
app.get('/api/gmail/status', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT id, created_at FROM gmail_tokens ORDER BY id DESC LIMIT 1');
    res.json({ connected: rows.length > 0, connectedAt: rows[0]?.created_at ?? null });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/gmail/auth-url', (_req, res: Response) => {
  const scopes = ['https://www.googleapis.com/auth/gmail.send'];
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(GMAIL_CLIENT_ID)}&redirect_uri=${encodeURIComponent(GMAIL_REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scopes.join(' '))}&access_type=offline&prompt=consent`;
  res.json({ url });
});

app.get('/api/gmail/callback', async (req: Request, res: Response) => {
  try {
    const code = req.query.code as string;
    if (!code) { res.status(400).send('Missing code parameter'); return; }

    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GMAIL_CLIENT_ID,
        client_secret: GMAIL_CLIENT_SECRET,
        redirect_uri: GMAIL_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });
    const tokenData = await tokenRes.json() as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string };
    if (tokenData.error || !tokenData.access_token) {
      res.status(400).send('OAuth error: ' + (tokenData.error || 'no access token'));
      return;
    }
    // Clear old tokens and store new
    await pool.query('DELETE FROM gmail_tokens');
    const expiry = tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null;
    await pool.query(
      'INSERT INTO gmail_tokens (access_token, refresh_token, expiry_date) VALUES ($1, $2, $3)',
      [tokenData.access_token, tokenData.refresh_token ?? null, expiry]
    );
    res.send('<html><body style="background:#0f0f0f;color:#c8a96e;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;font-size:20px"><div>Gmail connected! You can close this tab.</div></body></html>');
  } catch (e) { res.status(500).send('OAuth error: ' + String(e)); }
});

app.post('/api/gmail/disconnect', async (_req, res: Response) => {
  try {
    await pool.query('DELETE FROM gmail_tokens');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

async function getGmailAccessToken(): Promise<string | null> {
  const { rows } = await pool.query('SELECT * FROM gmail_tokens ORDER BY id DESC LIMIT 1');
  if (rows.length === 0) {
    console.log('[Gmail] No tokens stored — Gmail not connected');
    return null;
  }
  const token = rows[0];

  // Only skip refresh if expiry is explicitly set and still in the future
  const tokenStillValid = token.expiry_date && new Date(token.expiry_date) > new Date(Date.now() + 60_000); // 1-min buffer
  if (tokenStillValid) return token.access_token as string;

  // Token is expired, has unknown expiry, or expires very soon — refresh now
  if (!token.refresh_token) {
    console.warn('[Gmail] Token expired and no refresh_token stored — user needs to reconnect Gmail');
    return null;
  }

  try {
    console.log('[Gmail] Access token expired — attempting refresh…');
    const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: token.refresh_token as string,
        client_id: GMAIL_CLIENT_ID,
        client_secret: GMAIL_CLIENT_SECRET,
        grant_type: 'refresh_token',
      }),
    });
    const data = await refreshRes.json() as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (data.error) {
      console.error(`[Gmail] Token refresh failed: ${data.error} — ${data.error_description || ''}`);
      if (data.error === 'invalid_grant') {
        // Token is permanently revoked — clear it so the UI shows disconnected
        await pool.query('DELETE FROM gmail_tokens WHERE id=$1', [token.id]);
        console.warn('[Gmail] Cleared invalid refresh token — user must reconnect Gmail');
      }
      return null;
    }
    if (data.access_token) {
      const expiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
      await pool.query(
        'UPDATE gmail_tokens SET access_token=$1, expiry_date=$2, updated_at=NOW() WHERE id=$3',
        [data.access_token, expiry, token.id]
      );
      console.log('[Gmail] Access token refreshed successfully');
      return data.access_token;
    }
    console.warn('[Gmail] Refresh returned no access_token (unknown error)');
    return null;
  } catch (e) {
    console.error('[Gmail] Token refresh network error:', e instanceof Error ? e.message : e);
    return null;
  }
}

async function sendGmailEmail(to: string, subject: string, htmlBody: string): Promise<{ ok: boolean; status: number }> {
  const accessToken = await getGmailAccessToken();
  if (!accessToken) {
    console.warn(`[Gmail] Cannot send email to ${to} — no valid access token`);
    return { ok: false, status: 0 };
  }

  const rawEmail = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    '',
    htmlBody,
  ].join('\r\n');

  const encoded = Buffer.from(rawEmail).toString('base64url');

  try {
    const sendRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ raw: encoded }),
    });

    if (sendRes.ok) {
      console.log(`[Gmail] ✓ Email sent successfully to ${to} — subject: "${subject}"`);
      return { ok: true, status: sendRes.status };
    } else {
      const errBody = await sendRes.text().catch(() => '');
      console.error(`[Gmail] ✗ Send failed (HTTP ${sendRes.status}) to ${to}: ${errBody.slice(0, 300)}`);
      return { ok: false, status: sendRes.status };
    }
  } catch (e) {
    console.error(`[Gmail] ✗ Network error sending to ${to}:`, e instanceof Error ? e.message : e);
    return { ok: false, status: 0 };
  }
}

app.post('/api/gmail/send-test', async (_req, res: Response) => {
  try {
    const { rows: cRows } = await pool.query('SELECT your_email FROM criteria LIMIT 1');
    const email = cRows[0]?.your_email;
    if (!email) { res.status(400).json({ error: 'Set your email in User Search Settings first' }); return; }

    // Weekly digest: top 10 from past 7 days
    const { rows: jobs } = await pool.query(
      `SELECT * FROM jobs WHERE match_score >= 50 AND created_at >= NOW() - INTERVAL '7 days' ORDER BY match_score DESC LIMIT 10`
    );

    const narrative = await generateDigestNarrative(jobs);
    const html = buildDigestHtml(jobs, narrative);
    const result = await sendGmailEmail(email, 'JobScout.ai \u2014 Weekly Scout Report (Test)', html);
    if (result.ok) {
      res.json({ ok: true, message: 'Weekly report sent to ' + email });
    } else if (result.status === 403) {
      res.status(403).json({ error: 'Gmail permissions are outdated. Please Disconnect Gmail and reconnect to grant the Send Email permission.' });
    } else if (result.status === 401) {
      res.status(401).json({ error: 'Gmail token is invalid. Please Disconnect Gmail and reconnect.' });
    } else {
      res.status(500).json({ error: 'Failed to send email (HTTP ' + result.status + '). Check server logs.' });
    }
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/gmail/preview', async (_req, res: Response) => {
  try {
    // Weekly digest: top 10 from past 7 days
    const { rows: jobs } = await pool.query(
      `SELECT * FROM jobs WHERE match_score >= 50 AND created_at >= NOW() - INTERVAL '7 days' ORDER BY match_score DESC LIMIT 10`
    );
    const narrative = await generateDigestNarrative(jobs);
    res.json({ html: buildDigestHtml(jobs, narrative) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/gmail/weekly-status', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key='last_weekly_email_sent' LIMIT 1");
    const lastSent = rows[0]?.value || null;
    const { rows: timeRows } = await pool.query("SELECT value FROM settings WHERE key='digest_time' LIMIT 1");
    const sendTime = timeRows[0]?.value || '07:00';
    // Next Monday at sendTime
    const now = new Date();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
    const daysUntilMonday = dayOfWeek === 1 ? 7 : (8 - dayOfWeek) % 7 || 7;
    const nextMonday = new Date(now);
    nextMonday.setDate(now.getDate() + daysUntilMonday);
    const [h, m] = sendTime.split(':').map(Number);
    nextMonday.setHours(h, m, 0, 0);
    res.json({ lastSent, nextSend: nextMonday.toISOString(), sendTime });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── Narrative digest generator (weekly) ──────────────────────────────────
async function generateDigestNarrative(jobs: any[]): Promise<string> {
  try {
    const topTargets = jobs.filter(j => (j.opportunity_tier || '').toLowerCase().includes('top'));
    const fastWins   = jobs.filter(j => (j.opportunity_tier || '').toLowerCase().includes('fast'));

    const prompt = `You are an executive assistant briefing a senior sales professional on their weekly job scout results.

This week's scout found ${jobs.length} total matches: ${topTargets.length} Top Targets, ${fastWins.length} Fast Wins.

Top matches this week:
${topTargets.slice(0, 5).map(j => {
  return `- ${j.title} @ ${j.company} | Score: ${j.match_score} | ${j.salary || 'salary not listed'}`;
}).join('\n')}${fastWins.length > 0 ? `\nFast Wins:\n${fastWins.slice(0,2).map(j => `- ${j.title} @ ${j.company} | Score: ${j.match_score}`).join('\n')}` : ''}

Write EXACTLY 2-3 sentences in second person. Be specific and action-oriented:
1. Lead with the strongest opportunity of the week
2. Note any compensation or market pattern you see across the matches
3. End with one concrete action recommendation for this week

No bullet points. Maximum 3 sentences. Write like a sharp analyst briefing an executive.`;

    const AnthropicSdk = (await import('@anthropic-ai/sdk')).default;
    const ac = new AnthropicSdk({
      apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
      ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL } : {}),
    });
    const response = await ac.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 250,
      messages: [{ role: 'user', content: prompt }],
    });
    return response.content[0]?.type === 'text' ? response.content[0].text.trim() : '';
  } catch (e) {
    console.error('[DigestNarrative] Failed:', e instanceof Error ? e.message : e);
    return '';
  }
}

// ── Background job tailoring (fire-and-forget) ────────────────────────────
async function tailorJobInBackground(jobId: number): Promise<void> {
  const { rows: cached } = await pool.query(
    'SELECT id FROM tailored_resumes WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1', [jobId]
  );
  if (cached.length > 0) return;

  const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
  if (!jobRows.length) return;
  const job = jobRows[0] as Record<string, unknown>;

  const { rows: resumeRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
  const resumeText: string = (resumeRows[0]?.value as string) ?? '';
  if (!resumeText.trim()) return;

  const { rows: briefRows } = await pool.query(
    `SELECT brief_json FROM research_briefs WHERE LOWER(company_name)=LOWER($1) AND status='ready' AND created_at > NOW() - INTERVAL '48 hours' ORDER BY created_at DESC LIMIT 1`,
    [job.company as string]
  );
  let companyResearchContext: string | null = null;
  if (briefRows.length > 0) {
    try {
      const brief = briefRows[0].brief_json as Record<string, string>;
      const parts: string[] = [];
      if (brief.companyMoment) parts.push(`Company moment: ${brief.companyMoment}`);
      if (brief.productContext) parts.push(`Products: ${brief.productContext}`);
      if (brief.marketPosition) parts.push(`Market position: ${brief.marketPosition}`);
      companyResearchContext = parts.join('\n');
    } catch { /* ignore */ }
  }

  const { rows: dmRows } = await pool.query("SELECT value FROM settings WHERE key='document_model'");
  const documentModel: string = (dmRows[0]?.value as string) || 'claude-opus-4-6';
  const { rows: resumePromptRowsB } = await pool.query(
    "SELECT prompt_text FROM system_prompts WHERE prompt_name='resume_tailor'"
  );
  const resumeSystemPromptB: string | null = resumePromptRowsB[0]?.prompt_text ?? null;

  const detectedTerritory = detectTerritory(job.title as string, (job.description as string) ?? '');
  let territoryCtx = null;
  if (detectedTerritory) {
    territoryCtx = await analyzeTerritoryContext(job.title as string, job.company as string, detectedTerritory, resumeText);
  }

  const result = await tailorResumeV2WithClaude({
    jobTitle:               job.title as string,
    companyName:            job.company as string,
    jobDescription:         (job.description as string) ?? '',
    resumeText,
    companyResearchContext,
    model:                  documentModel,
    territoryContext:       territoryCtx,
    resumeSystemPrompt:     resumeSystemPromptB,
  });

  await pool.query(
    `INSERT INTO tailored_resumes (job_id, resume_text, ats_keywords, gap_analysis, ats_research) VALUES ($1,$2,$3,$4,$5)`,
    [jobId, result.resumeText, result.atsResearch.mustHaveKeywords, JSON.stringify(result.gapAnalysis), JSON.stringify(result.atsResearch)]
  );
  await pool.query(
    `DELETE FROM tailored_resumes WHERE job_id=$1 AND id NOT IN (SELECT id FROM tailored_resumes WHERE job_id=$1 ORDER BY created_at DESC LIMIT 3)`,
    [jobId]
  );
}

function autotailorTopMatches(runId: number): void {
  (async () => {
    try {
      const { rows: resumeRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
      if (!(resumeRows[0]?.value as string)?.trim()) {
        console.log('[AutoTailor] No resume set — skipping auto-tailoring.');
        return;
      }
      const { rows: topJobs } = await pool.query(
        `SELECT j.id, j.title, j.company FROM jobs j
         WHERE j.scout_run_id = $1
           AND j.opportunity_tier ILIKE 'Top Target'
           AND NOT EXISTS (SELECT 1 FROM tailored_resumes tr WHERE tr.job_id = j.id)
         ORDER BY j.match_score DESC LIMIT 3`,
        [runId]
      );
      if (topJobs.length === 0) {
        console.log('[AutoTailor] All Top Targets already tailored or none found.');
        return;
      }
      console.log(`[AutoTailor] Pre-tailoring ${topJobs.length} Top Target resume(s) in background…`);
      for (const job of topJobs) {
        try {
          console.log(`[AutoTailor]   Tailoring: ${job.title} @ ${job.company} (id: ${job.id})`);
          await tailorJobInBackground(job.id as number);
          console.log(`[AutoTailor]   ✓ Done: ${job.title} @ ${job.company}`);
        } catch (e) {
          console.error(`[AutoTailor]   ✗ Failed (job ${job.id}):`, e instanceof Error ? e.message : e);
        }
      }
      console.log('[AutoTailor] Background tailoring complete.');
    } catch (e) {
      console.error('[AutoTailor] Fatal:', e instanceof Error ? e.message : e);
    }
  })();
}

function buildDigestHtml(jobs: any[], narrative = ''): string {
  const topTargets = jobs.filter(j => (j.opportunity_tier || '').toLowerCase().includes('top'));
  const fastWins   = jobs.filter(j => (j.opportunity_tier || '').toLowerCase().includes('fast'));

  // Show top 10 ranked by score
  const displayJobs = jobs.slice(0, 10);

  const jobCards = displayJobs.map((j, idx) => {
    const tierBg = (j.opportunity_tier || '').toLowerCase().includes('top') ? '#c8a96e' : (j.opportunity_tier || '').toLowerCase().includes('fast') ? '#4ade80' : '#888';
    const jobData = JSON.stringify({ title: j.title, company: j.company, location: j.location, salary: j.salary || '', score: j.match_score, why: j.why_good_fit || '', url: j.apply_url }).replace(/"/g, '&quot;');
    return `
    <div class="digest-job" data-job="${jobData}" style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:16px;margin-bottom:12px;position:relative">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
        <div>
          <span style="color:#555;font-size:11px;font-weight:700;margin-right:6px">#${idx + 1}</span>
          <span style="color:#c8a96e;font-weight:bold;font-size:16px">${esc(j.title)}</span>
          ${j.opportunity_tier ? `<div style="margin-top:4px"><span style="background:${tierBg}22;color:${tierBg};border:1px solid ${tierBg}44;padding:1px 8px;border-radius:3px;font-size:11px;font-weight:700">${esc(j.opportunity_tier)}</span></div>` : ''}
        </div>
        <span style="background:#c8a96e;color:#0f0f0f;padding:2px 10px;border-radius:12px;font-weight:bold;font-size:13px;white-space:nowrap">${esc(j.match_score)}/100</span>
      </div>
      <div style="color:#999;margin:6px 0;font-size:13px">${esc(j.company)} • ${esc(j.location)}${j.salary ? ' • <strong style="color:#c8a96e">' + esc(j.salary) + '</strong>' : ''}</div>
      <div style="color:#bbb;font-size:13px;margin:8px 0;line-height:1.5">${esc(j.why_good_fit)}</div>
      <a href="${esc(j.apply_url)}" style="display:inline-block;background:#c8a96e;color:#0f0f0f;padding:6px 16px;border-radius:4px;font-size:12px;font-weight:700;text-decoration:none;margin-top:4px">Apply Now →</a>
    </div>
  `;}).join('');

  const narrativeBlock = narrative ? `
    <div style="background:#1a1a1a;border:1px solid #c8a96e44;border-left:3px solid #c8a96e;border-radius:6px;padding:16px 18px;margin-bottom:24px">
      <div style="color:#c8a96e;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px">Weekly Scout Briefing</div>
      <div style="color:#e8e6e0;font-size:14px;line-height:1.6">${esc(narrative)}</div>
    </div>` : '';

  // Date range for "this week"
  const now = new Date();
  const weekStart = new Date(now); weekStart.setDate(now.getDate() - 7);
  const weekRange = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

  const statsBlock = `
    <div style="display:flex;gap:16px;margin-bottom:20px;flex-wrap:wrap">
      <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px 16px;flex:1;min-width:80px;text-align:center">
        <div style="color:#c8a96e;font-size:20px;font-weight:700">${jobs.length}</div>
        <div style="color:#666;font-size:11px">Matches This Week</div>
      </div>
      <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px 16px;flex:1;min-width:80px;text-align:center">
        <div style="color:#c8a96e;font-size:20px;font-weight:700">${topTargets.length}</div>
        <div style="color:#666;font-size:11px">Top Targets</div>
      </div>
      <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px 16px;flex:1;min-width:80px;text-align:center">
        <div style="color:#4ade80;font-size:20px;font-weight:700">${fastWins.length}</div>
        <div style="color:#666;font-size:11px">Fast Wins</div>
      </div>
    </div>`;

  return `
    <div style="background:#0f0f0f;color:#e8e6e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;max-width:640px;margin:0 auto">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="color:#c8a96e;font-size:22px;margin:0">&#x2B21; JobScout.ai — Weekly Scout Report</h1>
        <p style="color:#666;font-size:13px;margin-top:6px">Top 10 matches &mdash; ${weekRange}</p>
      </div>
      ${narrativeBlock}
      ${statsBlock}
      ${displayJobs.length > 0 ? jobCards : '<div style="color:#666;text-align:center;padding:32px">No matches found this week. The scout is still running — check back next Monday!</div>'}
      ${jobs.length > 10 ? `<div style="text-align:center;color:#555;font-size:12px;margin-top:16px">Showing top 10 of ${jobs.length} total matches. Log in to JSOS.ai to see all.</div>` : ''}
    </div>
  `;
}

// ── Scout background worker ───────────────────────────────────────────────

// Words that appear as modifiers/prefixes in role phrases but don't identify the role type.
// We strip these from the start of a target role phrase to get the "core" identifying phrase.
const ROLE_MODIFIER_WORDS = new Set([
  'sr', 'sr.', 'senior', 'jr', 'jr.', 'junior', 'lead', 'principal', 'staff',
  'enterprise', 'named', 'commercial', 'corporate', 'mid-market', 'midmarket',
  'mid', 'market', 'regional', 'territory', 'national', 'global', 'strategic',
  'major', 'majors', 'key', 'inside', 'field', 'federal', 'digital', 'cloud',
  'partner', 'channel', 'upmarket', 'growth', 'smb', 'large', 'new', 'business',
  'technical', 'solution', 'solutions', 'healthcare', 'of', 'the', 'and', 'a', 'an',
  'quota', 'carrying', 'quota-carrying',
]);

// Abbreviation expansions — when a user types a short form, match the full form
const ABBREV_EXPANSIONS: Record<string, string[]> = {
  'ae':  ['Account\\s+Executive'],
  'am':  ['Account\\s+Manager'],
  'sdr': ['Sales\\s+Development\\s+Representative', 'Business\\s+Development\\s+Representative'],
  'bdr': ['Business\\s+Development\\s+Representative', 'Sales\\s+Development\\s+Representative'],
  'bdm': ['Business\\s+Development\\s+Manager'],
  'csm': ['Customer\\s+Success\\s+Manager'],
  'se':  ['Sales\\s+Executive'],
  'rvp': ['(?:Regional|Area)\\s+Vice\\s+President'],
  'vp':  ['Vice\\s+President'],
};

function buildTitleFilter(targetRoles: string[]): RegExp | null {
  if (!targetRoles || targetRoles.length === 0) return null;

  const corePatterns: string[] = [];

  for (const role of targetRoles) {
    const normalized = role.trim().toLowerCase();

    // Check if this is a known abbreviation
    if (ABBREV_EXPANSIONS[normalized]) {
      corePatterns.push(...ABBREV_EXPANSIONS[normalized]);
      continue;
    }

    // Strip leading modifier words to get the core identifying phrase
    const words = role.trim().split(/\s+/);
    let start = 0;
    while (start < words.length - 1 && ROLE_MODIFIER_WORDS.has(words[start].toLowerCase().replace(/\.$/, ''))) {
      start++;
    }
    const coreWords = words.slice(start);

    if (coreWords.length === 0) {
      // Fallback: use full phrase
      const escaped = role.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      corePatterns.push(escaped.replace(/\s+/g, '\\s+'));
    } else {
      // Match the core phrase (which may appear anywhere in the title, with any modifiers before it)
      const escaped = coreWords.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
      corePatterns.push(escaped);
    }

    // Reverse: if core phrase is a known full form, also add the abbreviation
    const coreNorm = coreWords.join(' ').toLowerCase();
    if (coreNorm === 'account executive') corePatterns.push('\\bAE\\b');
    else if (coreNorm === 'account manager') corePatterns.push('\\bAM\\b');
    else if (coreNorm === 'sales development representative') corePatterns.push('\\bSDR\\b');
    else if (coreNorm === 'business development representative') corePatterns.push('\\bBDR\\b');
    else if (coreNorm === 'business development manager') corePatterns.push('\\bBDM\\b');
    else if (coreNorm === 'customer success manager') corePatterns.push('\\bCSM\\b');
  }

  if (corePatterns.length === 0) return null;

  // Deduplicate patterns
  const unique = [...new Set(corePatterns)];
  return new RegExp(`(${unique.join('|')})`, 'i');
}

// ── Background URL health check ─────────────────────────────────────────────
// Checks unchecked job URLs in batches of 12, marks url_ok true/false.
// Runs entirely in the background — does not block the scout run.
// Safe: never removes jobs; broken links are surfaced in the UI only.
async function checkUrlHealthInBackground(jobIds?: number[]): Promise<void> {
  try {
    let rows: Array<{ id: number; apply_url: string }>;
    if (jobIds && jobIds.length > 0) {
      const { rows: r } = await pool.query(
        `SELECT id, apply_url FROM jobs WHERE id = ANY($1) AND url_ok IS NULL LIMIT 200`,
        [jobIds]
      );
      rows = r;
    } else {
      const { rows: r } = await pool.query(
        `SELECT id, apply_url FROM jobs WHERE url_ok IS NULL ORDER BY found_at DESC LIMIT 200`
      );
      rows = r;
    }
    if (!rows.length) return;
    console.log(`URL health check: checking ${rows.length} unchecked job URLs…`);
    let ok = 0, broken = 0, skipped = 0;
    const BATCH = 12;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      await Promise.allSettled(batch.map(async ({ id, apply_url }) => {
        // Skip LinkedIn — always requires auth; mark as unknown (null) not broken
        if (apply_url.includes('linkedin.com')) { skipped++; return; }
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 6000);
          const res = await fetch(apply_url, {
            method: 'HEAD',
            redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobScout/1.0)' },
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          const isOk = res.status < 400;
          await pool.query(`UPDATE jobs SET url_ok=$1, url_checked_at=NOW() WHERE id=$2`, [isOk, id]);
          if (isOk) ok++; else broken++;
        } catch {
          // Timeout or network error — leave url_ok as null (not marked broken)
          skipped++;
        }
      }));
      // Brief pause between batches to avoid hammering servers
      if (i + BATCH < rows.length) await new Promise(r => setTimeout(r, 800));
    }
    console.log(`URL health check complete: ${ok} live, ${broken} broken, ${skipped} skipped`);
  } catch (e) {
    console.error('URL health check error:', e);
  }
}

async function runScoutInBackground(runId: number): Promise<void> {
  try {
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    if (cRows.length === 0) {
      await pool.query("UPDATE scout_runs SET status='failed', error='No criteria configured', completed_at=NOW() WHERE id=$1", [runId]);
      return;
    }
    const criteria = cRows[0] as {
      target_roles: string[]; industries: string[]; min_salary: number | null; min_ote: number | null;
      locations: string[]; must_have: string[]; nice_to_have: string[]; avoid: string[];
      remote_strict: boolean; experience_level: string; work_type: string;
      stretch_companies: string[]; vertical_niches: string[];
      top_target_score: number; fast_win_score: number; stretch_score: number;
      allowed_work_modes: string[]; experience_levels: string[];
      proxy_url: string;
    };
    const tierSettings: TierSettings = {
      verticalNiches: criteria.vertical_niches ?? [],
      topTargetScore: criteria.top_target_score ?? 65,
      fastWinScore: criteria.fast_win_score ?? 55,
      stretchScore: criteria.stretch_score ?? 55,
      experienceLevels: criteria.experience_levels ?? ['senior'],
    };

    const setStage = async (stage: string) => {
      await pool.query(`UPDATE scout_runs SET current_stage=$1 WHERE id=$2`, [stage, runId]).catch(() => {});
    };

    const { rows: companies } = await pool.query('SELECT * FROM companies');
    console.log(`\n════════════════════════════════════════════════════════════`);
    console.log(`SCOUT RUN #${runId} — ${companies.length} companies loaded from database`);
    console.log(`════════════════════════════════════════════════════════════`);
    const byType: Record<string, number> = {};
    for (const c of companies) { byType[(c as any).ats_type] = (byType[(c as any).ats_type] || 0) + 1; }
    console.log(`  Companies by ATS type:`, byType);

    type Job = { title: string; company: string; location: string; salary?: string; applyUrl: string; description?: string; datePosted?: string; source: string; _fromJobSpy?: boolean; _fromGemini?: boolean };
    const allJobs: Job[] = [];
    // Side-map: applyUrl → per-job metadata for Gemini-sourced jobs
    const geminiMetaByUrl = new Map<string, { groundingMetadata?: object; confidence?: number }>();
    let companiesScanned = 0;
    const perCompanyStats: { name: string; type: string; jobs: number; error?: string }[] = [];

    await setStage(`Scraping ${companies.length} ATS job boards…`);
    // ── Stage 2a: Scrape Greenhouse, Lever, and Workday companies ──
    for (const c of companies) {
      const co = c as { id: number; name: string; ats_type: string; ats_slug: string | null; careers_url: string | null; scan_failures: number; ats_types_tried: string[] };
      try {
        let jobCount = 0;
        let scraped = false;
        if (co.ats_type === 'greenhouse' && co.ats_slug) {
          const jobs = await scrapeGreenhouseJobs(co.ats_slug, co.name);
          jobCount = jobs.length;
          allJobs.push(...jobs.map(j => ({ ...j, source: 'Greenhouse' })));
          perCompanyStats.push({ name: co.name, type: co.ats_type, jobs: jobCount });
          scraped = true;
        } else if (co.ats_type === 'lever' && co.ats_slug) {
          const jobs = await scrapeLeverJobs(co.ats_slug, co.name);
          jobCount = jobs.length;
          allJobs.push(...jobs.map(j => ({ ...j, source: 'Lever' })));
          perCompanyStats.push({ name: co.name, type: co.ats_type, jobs: jobCount });
          scraped = true;
        } else if (co.ats_type === 'workday' && co.ats_slug && co.careers_url) {
          const jobs = await scrapeWorkdayJobs(co.name, co.careers_url, co.ats_slug);
          jobCount = jobs.length;
          allJobs.push(...jobs.map(j => ({ ...j, source: 'Workday' })));
          perCompanyStats.push({ name: co.name, type: co.ats_type, jobs: jobCount });
          scraped = true;
        }
        // "plain" companies: covered by JobSpy broad search below
        if (scraped) {
          // Clear failure streak on success
          if ((co.scan_failures ?? 0) > 0) {
            await pool.query(
              `UPDATE companies SET scan_failures=0, last_scan_error=NULL WHERE id=$1`,
              [co.id]
            ).catch(() => {});
          }
        }
        companiesScanned++;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        perCompanyStats.push({ name: co.name, type: co.ats_type, jobs: 0, error: errMsg });
        console.error(`Error scraping ${co.name}:`, e);
        // Record failure for retry logic
        await pool.query(
          `UPDATE companies SET
             scan_failures = scan_failures + 1,
             last_scan_error = $1,
             ats_types_tried = array_append(ats_types_tried, $2),
             detect_status = CASE WHEN detect_status = 'detected' THEN 'failed' ELSE detect_status END
           WHERE id = $3`,
          [errMsg, co.ats_type, co.id]
        ).catch(() => {});
        companiesScanned++;
      }
    }

    await setStage(`ATS done (${allJobs.length} found) — searching LinkedIn & Indeed via JobSpy…`);
    await pool.query(`UPDATE scout_runs SET jobs_in_pipeline=$1 WHERE id=$2`, [allJobs.length, runId]).catch(() => {});
    // ── Stage 2b: JobSpy — LinkedIn + Indeed + (Glassdoor/ZipRecruiter via proxy) ──
    try {
      const jobSpyResults = await runJobSpyScraper({
        target_roles: criteria.target_roles ?? [],
        locations: criteria.locations ?? [],
        proxy_url: criteria.proxy_url ?? '',
      });
      console.log(`JobSpy returned ${jobSpyResults.length} jobs — adding all to pipeline`);
      // Use the per-job source tag from the scraper (linkedin / indeed / glassdoor / ziprecruiter)
      // Capitalise for display; fall back to 'JobSpy' if unrecognised
      allJobs.push(...jobSpyResults.map(j => {
        const src = (j.source ?? '').toLowerCase();
        const displaySrc = src === 'linkedin' ? 'LinkedIn'
          : src === 'indeed' ? 'Indeed'
          : src === 'glassdoor' ? 'Glassdoor'
          : src === 'ziprecruiter' ? 'ZipRecruiter'
          : 'JobSpy';
        return { ...j, source: displaySrc, _fromJobSpy: true };
      }));
    } catch (e) {
      console.error(`JobSpy scraper error:`, e);
    }

    // ── Stage 2c: Filter out unsafe companies from all JobSpy-sourced results ──
    const companyNames = companies.map((c: any) => c.name as string);
    const jobSpyJobs = allJobs.filter(j => (j as any)._fromJobSpy);
    const nonJobSpyJobs = allJobs.filter(j => !(j as any)._fromJobSpy);
    if (jobSpyJobs.length > 0) {
      const safeJobSpyJobs = await filterUnsafeCompanies(
        jobSpyJobs.map(j => ({ title: j.title, company: j.company, location: j.location, salary: j.salary, applyUrl: j.applyUrl, description: j.description })),
        companyNames
      );
      const filteredOut = jobSpyJobs.length - safeJobSpyJobs.length;
      // Count per source for logging
      const srcCounts = jobSpyJobs.reduce((acc: Record<string, number>, j) => { acc[j.source] = (acc[j.source] ?? 0) + 1; return acc; }, {});
      console.log(`Company safety filter: ${jobSpyJobs.length} jobs (${JSON.stringify(srcCounts)}) → ${safeJobSpyJobs.length} passed (${filteredOut} filtered out)`);
      // Rebuild allJobs — preserve the per-source tag from above
      allJobs.length = 0;
      allJobs.push(...nonJobSpyJobs);
      // Re-attach the correct source to each safe job using its applyUrl as key
      const sourceByUrl = new Map(jobSpyJobs.map(j => [j.applyUrl, j.source]));
      allJobs.push(...safeJobSpyJobs.map(j => ({ ...j, source: sourceByUrl.get(j.applyUrl) ?? 'JobSpy' })));
    }

    await setStage(`JobSpy done (${allJobs.length} total) — running Gemini discovery…`);
    await pool.query(`UPDATE scout_runs SET jobs_in_pipeline=$1 WHERE id=$2`, [allJobs.length, runId]).catch(() => {});
    // ── Stage 2c: Gemini + Google Search grounding — supplemental discovery ──
    let geminiJobsFound = 0;
    let geminiDeduped = 0;
    try {
      const geminiResult = await runGeminiJobDiscovery({
        target_roles:  criteria.target_roles ?? [],
        locations:     criteria.locations ?? [],
        work_type:     criteria.work_type ?? 'any',
        must_have:     criteria.must_have ?? [],
        nice_to_have:  criteria.nice_to_have ?? [],
        avoid:         criteria.avoid ?? [],
        industries:    criteria.industries ?? [],
        min_salary:    criteria.min_salary ?? null,
      });

      if (!geminiResult.skipped && geminiResult.jobs.length > 0) {
        // Merge Gemini results with existing allJobs — dedup by URL + company+title
        const { merged, deduplicatedCount } = deduplicateJobLists(
          allJobs as Array<ScrapedJob & { source: string; _fromJobSpy?: boolean }>,
          geminiResult.jobs
        );

        geminiJobsFound = geminiResult.jobs.length;
        geminiDeduped   = deduplicatedCount;
        const netNew    = geminiJobsFound - deduplicatedCount;

        // Store gemini metadata for net-new jobs so we can persist it to DB later
        for (const gJob of geminiResult.jobs) {
          if (!allJobs.some(j => j.applyUrl === gJob.applyUrl)) {
            geminiMetaByUrl.set(gJob.applyUrl, {
              groundingMetadata: gJob.geminiGroundingMetadata as object | undefined,
              confidence:        gJob.ingestionConfidence,
            });
          }
        }

        // Rebuild allJobs from merged (preserves all existing + net-new Gemini jobs)
        allJobs.length = 0;
        for (const j of merged) {
          allJobs.push({
            title:       j.title,
            company:     j.company,
            location:    j.location,
            salary:      j.salary,
            applyUrl:    j.applyUrl,
            description: j.description,
            source:      j.source,
            _fromJobSpy: (j as any)._fromJobSpy,
            _fromGemini: (j as any)._fromGemini,
          });
        }

        console.log(`[Gemini] ${geminiJobsFound} discovered → ${deduplicatedCount} dupes merged → ${netNew} net-new added`);
        console.log(`[Gemini] Grounding sources: ${geminiResult.totalGroundingSources} | Queries: ${geminiResult.queriesUsed.join(', ')}`);
      } else if (geminiResult.skipped) {
        console.log(`[Gemini] Skipped: ${geminiResult.skipReason}`);
      }
    } catch (e) {
      console.error(`[Gemini] Unexpected error (non-fatal):`, e);
    }

    console.log(`\n──── SCRAPE RESULTS ────────────────────────────────────────`);
    console.log(`Total scraped: ${allJobs.length} raw listings from ${companiesScanned} companies`);
    const companiesWithJobs = perCompanyStats.filter(s => s.jobs > 0);
    const companiesWithZero = perCompanyStats.filter(s => s.jobs === 0);
    console.log(`  Companies WITH jobs (${companiesWithJobs.length}):`);
    for (const s of companiesWithJobs) console.log(`    ✓ ${s.name} (${s.type}): ${s.jobs} jobs`);
    console.log(`  Companies with ZERO jobs (${companiesWithZero.length}):`);
    for (const s of companiesWithZero) console.log(`    ✗ ${s.name} (${s.type})${s.error ? ` — ERROR: ${s.error}` : ''}`);
    console.log(`───────────────────────────────────────────────────────────`);

    const titleFilter = buildTitleFilter(criteria.target_roles);
    console.log(`\n──── TITLE FILTER ──────────────────────────────────────────`);
    console.log(`Title filter regex: ${titleFilter?.source.slice(0, 200)}...`);
    // All sources now have real job titles, so filter everything through title filter
    const filtered = titleFilter
      ? allJobs.filter((j) => titleFilter.test(j.title))
      : allJobs;
    const toScore = filtered;
    const droppedByTitle = allJobs.length - filtered.length;
    console.log(`Title filter: ${allJobs.length} total → ${filtered.length} passed (${droppedByTitle} dropped)`);
    // Show per-company breakdown of what passed the title filter
    const passedByCompany: Record<string, number> = {};
    const droppedByCompany: Record<string, number> = {};
    for (const j of allJobs) {
      if (!titleFilter || titleFilter.test(j.title)) {
        passedByCompany[j.company] = (passedByCompany[j.company] || 0) + 1;
      } else {
        droppedByCompany[j.company] = (droppedByCompany[j.company] || 0) + 1;
      }
    }
    console.log(`  Passed title filter by company:`);
    for (const [co, count] of Object.entries(passedByCompany)) console.log(`    ✓ ${co}: ${count}`);
    if (Object.keys(droppedByCompany).length > 0) {
      console.log(`  Dropped by title filter (${Object.values(droppedByCompany).reduce((a,b) => a+b, 0)} total):`);
      for (const [co, count] of Object.entries(droppedByCompany)) console.log(`    ✗ ${co}: ${count} dropped`);
    }
    console.log(`───────────────────────────────────────────────────────────`);

    // ── Hard pre-filters (before Claude scoring) to save API costs ──

    // 1. Location hard filter — only pass jobs that match user's location preferences
    const hasLocationPrefs = criteria.locations.length > 0;
    const allowedWorkModes: string[] = criteria.allowed_work_modes ?? [];

    function jobMatchesLocation(jobLocation: string): boolean {
      if (!hasLocationPrefs && allowedWorkModes.length === 0) return true;
      return checkJobLocation(jobLocation, criteria.locations, false, allowedWorkModes);
    }

    // 2. Avoid keywords hard filter — exclude jobs whose title or description contains avoid keywords
    const avoidPatterns = criteria.avoid
      .filter(k => k.trim().length > 0)
      .map(k => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));

    function jobContainsAvoid(job: Job): boolean {
      for (const pattern of avoidPatterns) {
        if (pattern.test(job.title)) return true;
        if (job.description && pattern.test(job.description)) return true;
      }
      return false;
    }

    // 3. Salary hard filter — exclude jobs where listed salary is below minimum
    function jobBelowMinSalary(job: Job): boolean {
      if (!criteria.min_salary || !job.salary) return false;
      // Try to extract a number from the salary string
      const nums = job.salary.match(/[\d,]+/g);
      if (!nums) return false;
      // Use the highest number found (could be a range like "$100,000 - $150,000")
      const highest = Math.max(...nums.map(n => parseInt(n.replace(/,/g, ''), 10)));
      if (isNaN(highest) || highest === 0) return false;
      // If salary looks like hourly (< 1000), skip filtering
      if (highest < 1000) return false;
      return highest < criteria.min_salary;
    }

    // 4. Segment filter — block explicitly lower-ACV segment titles (Commercial/MM/SMB)
    //    when the user's target roles don't explicitly include those segments.
    //    These roles pay significantly less and represent a different sales motion.
    const userRolesLower = (criteria.target_roles ?? []).map((r: string) => r.toLowerCase());
    const wantsCommercial = userRolesLower.some(r => /commercial|mid.?market|smb|small.?biz/i.test(r));
    const SEGMENT_EXCLUDE = /\b(commercial|mid[\s-]market|mid-market\s+ae|smb|small\s+business|small\s+&\s+medium)\b/i;
    // Segment keyword in the title signals the segment, not the industry vertical
    // e.g., "Account Executive, Commercial" vs "Commercial Real Estate AE" — distinguish
    const SEGMENT_ROLE_CTX = /(account|sales|ae\b|rep\b)/i;

    function isExcludedSegment(title: string): boolean {
      if (wantsCommercial) return false; // user explicitly wants these
      if (!SEGMENT_EXCLUDE.test(title)) return false;
      return SEGMENT_ROLE_CTX.test(title); // only block when it's clearly the sales segment
    }

    // 5. Territory filter — block job titles with an explicit regional territory
    //    that is clearly OUTSIDE the user's preferred locations.
    //    e.g., user is SE/Remote → "(Northeast)" in title = hard mismatch.
    const userLocLower = (criteria.locations ?? []).map((l: string) => l.toLowerCase());
    const isSEUser = userLocLower.some(l => /south.?carolina|north.?carolina|georgia|florida|southeast|se\b/.test(l));
    const TERRITORY_EXCLUDE = /\b(northeast|new\s+england|mid[\s-]atlantic|midwest|great\s+lakes|north\s+central|northwest|pacific\s+northwest|pnw|west\s+coast|southwest|tola|mountain\s+west|rocky\s+mountain|plains|upper\s+midwest)\b/i;
    const TERRITORY_SE_OK   = /\b(southeast|southern|carolinas?|florida|georgia|sc\b|nc\b|fl\b|ga\b)\b/i;

    function isExcludedTerritory(title: string): boolean {
      if (!isSEUser) return false; // only apply if user is clearly SE-based
      if (!TERRITORY_EXCLUDE.test(title)) return false;
      // If it also mentions SE territory, let it through (e.g., "SE + Northeast" hybrid)
      if (TERRITORY_SE_OK.test(title)) return false;
      return true;
    }

    // Apply all hard pre-filters
    let preFiltered = toScore;
    let droppedByLocation = 0;
    let droppedByAvoid = 0;
    let droppedBySalary = 0;
    let droppedByTerritory = 0;

    if (hasLocationPrefs) {
      const before = preFiltered.length;
      preFiltered = preFiltered.filter(j => jobMatchesLocation(j.location));
      droppedByLocation = before - preFiltered.length;
    }
    if (avoidPatterns.length > 0) {
      const before = preFiltered.length;
      preFiltered = preFiltered.filter(j => !jobContainsAvoid(j));
      droppedByAvoid = before - preFiltered.length;
    }
    if (criteria.min_salary) {
      const before = preFiltered.length;
      preFiltered = preFiltered.filter(j => !jobBelowMinSalary(j));
      droppedBySalary = before - preFiltered.length;
    }

    // Apply territory filter only (segment is NOT a hard block — compensation handles it)
    {
      const before = preFiltered.length;
      preFiltered = preFiltered.filter(j => !isExcludedTerritory(j.title));
      droppedByTerritory = before - preFiltered.length;
    }

    let droppedByKnownComp = 0; // reserved for future use

    console.log(`\n──── PRE-FILTERS (before Claude scoring) ───────────────────`);
    console.log(`  After title filter: ${toScore.length}`);
    console.log(`  Dropped by location: ${droppedByLocation}`);
    console.log(`  Dropped by avoid keywords: ${droppedByAvoid}`);
    console.log(`  Dropped by salary below $${criteria.min_salary?.toLocaleString() ?? 'n/a'}: ${droppedBySalary}`);
    console.log(`  Dropped by territory mismatch: ${droppedByTerritory}`);
    console.log(`  Dropped by known comp below minimum: ${droppedByKnownComp}`);
    console.log(`  Remaining for Claude scoring: ${preFiltered.length}`);
    console.log(`───────────────────────────────────────────────────────────`);

    // ── Skip jobs already in the DB — only score genuinely new listings ──
    const { rows: existingRows } = await pool.query('SELECT apply_url FROM jobs');
    const seenUrls = new Set(existingRows.map((r: any) => r.apply_url as string));
    const newJobs = preFiltered.filter(j => !seenUrls.has(j.applyUrl));
    const skippedAlreadySeen = preFiltered.length - newJobs.length;
    console.log(`\n──── NEW JOB FILTER ─────────────────────────────────────────`);
    console.log(`  Already in DB (skipped): ${skippedAlreadySeen}`);
    console.log(`  Genuinely new → Claude:  ${newJobs.length}`);
    console.log(`───────────────────────────────────────────────────────────`);

    if (newJobs.length === 0) {
      await pool.query(
        "UPDATE scout_runs SET status='completed', companies_scanned=$1, jobs_found=$2, matches_found=0, completed_at=NOW() WHERE id=$3",
        [companiesScanned, allJobs.length, runId]
      );
      return;
    }

    // ── Pre-scoring ATS enrichment (Greenhouse / Lever / Ashby) ─────────────
    // Fetch real job descriptions for ATS-direct jobs with short/missing descriptions
    // BEFORE Claude scores them — so Claude sees the full JD, not a scraped stub.
    {
      const atsTargets = newJobs.filter(j => {
        const url = (j.applyUrl ?? '').toLowerCase();
        return (url.includes('greenhouse.io') || url.includes('lever.co') || url.includes('ashbyhq.com'))
          && (j.description ?? '').replace(/<[^>]+>/g, '').trim().length < 200;
      });
      if (atsTargets.length > 0) {
        console.log(`\n──── PRE-SCORING ATS ENRICHMENT ────────────────────────────`);
        console.log(`  ${atsTargets.length} jobs with ATS URLs + short descriptions → fetching real JDs…`);
        const { enriched } = await enrichJobsPreScoring(newJobs);
        console.log(`  Done: ${enriched} descriptions enriched before Claude scoring`);
        console.log(`───────────────────────────────────────────────────────────`);
      }
    }

    await setStage(`Scoring ${newJobs.length} new jobs with Claude AI…`);
    // Load the candidate's resume for resume-aware scoring
    const { rows: resumeSettingRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
    const candidateResume: string = resumeSettingRows[0]?.value ?? '';

    // ── Company Momentum Pre-Check ──────────────────────────────────────────
    // Run Gemini momentum check for all unique companies (in parallel, up to 10 at a time).
    // Results feed directly into Claude's companyQuality scoring component.
    const uniqueCompaniesForMomentum = Array.from(new Set(
      newJobs.map(j => j.company.toLowerCase().trim())
    ));

    const momentumMap = new Map<string, MomentumScore>();
    if (uniqueCompaniesForMomentum.length > 0) {
      console.log(`\n──── MOMENTUM PRE-CHECK (${uniqueCompaniesForMomentum.length} companies) ──────────────────────────`);
      await setStage(`Checking company momentum for ${uniqueCompaniesForMomentum.length} companies…`);

      // Check DB cache first (48 h)
      for (const rawName of uniqueCompaniesForMomentum) {
        const realName = newJobs.find(j => j.company.toLowerCase().trim() === rawName)?.company ?? rawName;
        try {
          const { rows: cached } = await pool.query(
            `SELECT momentum_score, signals, warning FROM company_momentum WHERE LOWER(company_name) = LOWER($1) AND created_at > NOW() - INTERVAL '48 hours' ORDER BY created_at DESC LIMIT 1`,
            [realName]
          );
          if (cached.length > 0) {
            const c = cached[0] as Record<string, unknown>;
            const ms: MomentumScore = {
              companyName: realName,
              score: c.momentum_score as number,
              signals: (c.signals ?? []) as string[],
              warning: (c.warning ?? null) as string | null,
              cached: true,
            };
            momentumMap.set(rawName, ms);
            console.log(`  [Momentum] ${realName}: ${ms.score}/25 (DB cache)`);
          }
        } catch { /* DB not ready, skip cache */ }
      }

      // Run Gemini for companies not in cache (10 at a time)
      const toFetch = uniqueCompaniesForMomentum.filter(k => !momentumMap.has(k));
      const MOMENTUM_CONCURRENCY = 10;
      for (let i = 0; i < toFetch.length; i += MOMENTUM_CONCURRENCY) {
        const batch = toFetch.slice(i, i + MOMENTUM_CONCURRENCY);
        const results = await Promise.allSettled(batch.map(async (rawName) => {
          const realName = newJobs.find(j => j.company.toLowerCase().trim() === rawName)?.company ?? rawName;
          const isPreApproved = companyNames.some(n => n.toLowerCase() === rawName);
          const ms = await getCompanyMomentum(realName, isPreApproved);
          momentumMap.set(rawName, ms);
          // Persist to DB cache
          try {
            await pool.query(
              `INSERT INTO company_momentum (company_name, momentum_score, signals, warning) VALUES ($1, $2, $3, $4)`,
              [realName, ms.score, JSON.stringify(ms.signals), ms.warning]
            );
          } catch { /* ignore — non-critical */ }
        }));
        for (const r of results) {
          if (r.status === 'rejected') console.log(`  [Momentum] Error: ${r.reason}`);
        }
      }

      const warnings = Array.from(momentumMap.values()).filter(m => m.warning);
      console.log(`  Momentum complete: ${momentumMap.size} companies checked, ${warnings.length} warnings`);
      if (warnings.length) warnings.forEach(m => console.log(`    ⚠ ${m.companyName}: ${m.warning}`));
      console.log(`───────────────────────────────────────────────────────────`);
    }

    // Pass pre-approved company names from the database to Claude scoring
    // Only send genuinely new jobs (URLs not already in DB) to Claude
    const matches = await scoreJobsWithClaude(
      newJobs.map(j => ({ title: j.title, company: j.company, location: j.location, salary: j.salary, applyUrl: j.applyUrl, description: j.description })),
      {
        targetRoles: criteria.target_roles,
        industries: criteria.industries,
        minSalary: criteria.min_salary,
        minOte: criteria.min_ote ?? null,
        locations: criteria.locations,
        allowedWorkModes: criteria.allowed_work_modes ?? [],
        mustHave: criteria.must_have,
        niceToHave: criteria.nice_to_have,
        avoid: criteria.avoid,
        preApprovedCompanies: companyNames,
        tierSettings,
        candidateResume: candidateResume || undefined,
        acceptedExperienceLevels: criteria.experience_levels ?? ['senior'],
      },
      momentumMap,
    );

    console.log(`\n──── CLAUDE SCORING RESULTS ────────────────────────────────`);
    console.log(`Claude returned ${matches.length} matches from ${newJobs.length} new candidates`);
    if (matches.length > 0) {
      const matchesByCompany: Record<string, number> = {};
      for (const m of matches) matchesByCompany[m.company] = (matchesByCompany[m.company] || 0) + 1;
      console.log(`  Matches by company:`);
      for (const [co, count] of Object.entries(matchesByCompany)) console.log(`    ✓ ${co}: ${count} (scores: ${matches.filter(m=>m.company===co).map(m=>m.matchScore).join(', ')})`);
    }
    console.log(`───────────────────────────────────────────────────────────`);

    for (const m of matches) {
      const matchedJob = newJobs.find(j => j.applyUrl === m.applyUrl);
      const source = matchedJob?.source ?? '';
      const datePosted = matchedJob?.datePosted ?? null;
      const loc = (m.location ?? '').trim();
      let finalTier: string;

      // Apply location check + deterministic tier logic using our computeTier
      const locationOk = checkJobLocation(loc, criteria.locations, false, allowedWorkModes);
      if (!locationOk) {
        finalTier = 'Probably Skip';
      } else if (m.subScores && m.matchScore) {
        finalTier = computeTier(m.matchScore, m.aiRisk, m.subScores, m.title, m.company, loc, tierSettings);
      } else {
        finalTier = m.opportunityTier ?? 'unscored';
      }

      // Look up Gemini-specific metadata for this job (if it came from Gemini)
      const geminiMeta = geminiMetaByUrl.get(m.applyUrl);
      // Look up momentum warning for this company (if checked)
      const momWarning = momentumMap.get(m.company.toLowerCase().trim())?.warning ?? null;
      await pool.query(
        `INSERT INTO jobs (scout_run_id, title, company, location, salary, apply_url, original_url, original_title, original_description, description, why_good_fit, match_score, source, is_hardware, ai_risk, ai_risk_score, ai_risk_reason, opportunity_tier, sub_scores, gemini_grounding_metadata, ingestion_confidence, momentum_warning, date_posted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         ON CONFLICT (apply_url) DO NOTHING`,
        [runId, m.title, m.company, m.location, m.salary ?? null, m.applyUrl, m.applyUrl, m.title, m.description ?? null, m.description ?? null, m.whyGoodFit, m.matchScore, source, m.isHardware ?? false, m.aiRisk ?? 'unknown', m.aiRiskScore ?? null, m.aiRiskReason ?? null, finalTier, JSON.stringify(m.subScores ?? null), geminiMeta?.groundingMetadata ? JSON.stringify(geminiMeta.groundingMetadata) : null, geminiMeta?.confidence ?? null, momWarning, datePosted]
      );
    }

    // ── Background URL health check (non-blocking) ──────────────────────────
    // Runs after inserts so it doesn't slow down scoring; collects IDs of newly inserted jobs.
    {
      const { rows: newlyInserted } = await pool.query(
        `SELECT id FROM jobs WHERE scout_run_id = $1`,
        [runId]
      );
      const newIds = newlyInserted.map((r: any) => r.id as number);
      if (newIds.length > 0) {
        // Chain: URL health check → canonical resolution (canonical runs after health check so url_ok is populated)
        checkUrlHealthInBackground(newIds)
          .then(() => runCanonicalResolutionInBackground(pool, newIds))
          .catch(() => {});
      }
    }

    await setStage(`${matches.length} matches saved — estimating salaries…`);
    console.log(`\n──── DATABASE INSERT ───────────────────────────────────────`);
    console.log(`Saved ${matches.length} jobs to database for scout run #${runId}`);

    // ── Salary estimation for jobs missing salary ──────────────────────
    const needsSalary = matches.filter(m => !m.salary || m.salary === 'Unknown' || m.salary === 'N/A' || m.salary.trim() === '');
    if (needsSalary.length > 0) {
      console.log(`\n──── SALARY ESTIMATION ─────────────────────────────────────`);
      console.log(`Estimating salary for ${needsSalary.length} jobs missing salary data (up to 5 in parallel)...`);
      // Process in batches of 5
      for (let i = 0; i < needsSalary.length; i += 5) {
        const batch = needsSalary.slice(i, i + 5);
        await Promise.allSettled(batch.map(async (m) => {
          try {
            // Check cache first (7-day validity)
            const { rows: cached } = await pool.query(
              `SELECT * FROM salary_estimates WHERE LOWER(job_title) = LOWER($1) AND LOWER(company_name) = LOWER($2) AND created_at > NOW() - INTERVAL '7 days' LIMIT 1`,
              [m.title, m.company]
            );
            if (cached.length > 0) {
              console.log(`  ✓ ${m.title} @ ${m.company}: cached estimate`);
              return;
            }
            const estimate = await estimateSalary(m.title, m.company);
            await pool.query(
              `INSERT INTO salary_estimates (job_title, company_name, estimate_json) VALUES ($1, $2, $3)`,
              [m.title, m.company, JSON.stringify(estimate)]
            );
            console.log(`  ✓ ${m.title} @ ${m.company}: $${Math.round(estimate.oteLow/1000)}k-$${Math.round(estimate.oteHigh/1000)}k OTE (${estimate.confidence})`);
          } catch (e) {
            console.error(`  ✗ Salary estimate failed for ${m.title} @ ${m.company}:`, e instanceof Error ? e.message : e);
          }
        }));
      }
      console.log(`───────────────────────────────────────────────────────────`);
    }

    // ── Source breakdown for reporting ───────────────────────────────────
    const srcBreakdown: Record<string, number> = {};
    for (const j of allJobs) { srcBreakdown[j.source] = (srcBreakdown[j.source] ?? 0) + 1; }

    console.log(`════════════════════════════════════════════════════════════`);
    console.log(`SCOUT RUN #${runId} COMPLETE`);
    console.log(`  Companies scanned: ${companiesScanned}`);
    console.log(`  Raw jobs scraped:  ${allJobs.length}`);
    console.log(`  Source breakdown:  ${Object.entries(srcBreakdown).map(([k,v]) => `${k}: ${v}`).join(' | ')}`);
    if (geminiJobsFound > 0) {
      console.log(`  Gemini discovery:  ${geminiJobsFound} found → ${geminiDeduped} already in JobSpy → ${geminiJobsFound - geminiDeduped} net-new`);
    }
    console.log(`  Passed title filter: ${toScore.length}`);
    console.log(`  Pre-filtered (location/avoid/salary): ${preFiltered.length}`);
    console.log(`  Claude matches (score >= 50): ${matches.length}`);
    console.log(`  Saved to database: ${matches.length}`);
    console.log(`════════════════════════════════════════════════════════════\n`);

    await pool.query(
      "UPDATE scout_runs SET status='completed', companies_scanned=$1, jobs_found=$2, matches_found=$3, completed_at=NOW() WHERE id=$4",
      [companiesScanned, allJobs.length, matches.length, runId]
    );

    // Weekly email is handled by checkWeeklyEmail() scheduler — no per-run email

    // Background auto-tailoring: pre-tailor top 3 Top Targets (fire-and-forget)
    autotailorTopMatches(runId);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await pool.query(
      "UPDATE scout_runs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2",
      [msg, runId]
    );
  }
}

// Stats endpoint
app.get('/api/stats', async (_req, res: Response) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const { rows: todayJobs } = await pool.query(
      'SELECT COUNT(*) as count FROM jobs WHERE created_at >= $1', [today]
    );
    const { rows: todayMatches } = await pool.query(
      'SELECT COUNT(*) as count FROM jobs WHERE created_at >= $1 AND match_score >= 50', [today]
    );
    const { rows: topScore } = await pool.query(
      'SELECT MAX(match_score) as score FROM jobs WHERE created_at >= $1', [today]
    );
    const { rows: lastRun } = await pool.query(
      'SELECT * FROM scout_runs ORDER BY started_at DESC LIMIT 1'
    );
    res.json({
      jobsToday: Number(todayJobs[0]?.count ?? 0),
      matchesToday: Number(todayMatches[0]?.count ?? 0),
      topScore: Number(topScore[0]?.score ?? 0),
      lastRun: lastRun[0] ?? null,
    });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// ── HTML dashboard ────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function serveHTML(_req: Request, res: Response): Promise<void> {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  // Inject saved criteria so settings render instantly (no async flash)
  let criteriaJson = 'null';
  try {
    const { rows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    if (rows[0]) criteriaJson = JSON.stringify(rows[0]);
  } catch (_) {}
  const pageHtml = HTML.replace(
    '// ── init ──────────────────────────────────────────────────────────────────',
    `window.__initialCriteria__ = ${criteriaJson};\n// ── init ────────────────────────────────────────────────────────────────────`
  );
  res.end(pageHtml);
}

app.get('/', serveHTML);
app.get('/index.html', serveHTML);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start server ──────────────────────────────────────────────────────────

// ── Watchlist daily job scan ───────────────────────────────────────────────
async function checkWatchlistScan(): Promise<void> {
  if (watchlistScanRunning) return;
  try {
    const { rows: cos } = await pool.query('SELECT name FROM companies LIMIT 1');
    if (cos.length === 0) return;
    const { rows: recent } = await pool.query(
      `SELECT MAX(scanned_at) AS last FROM company_job_scan_results`
    );
    const last = recent[0]?.last;
    if (last) {
      const hoursSince = (Date.now() - new Date(last).getTime()) / 3_600_000;
      if (hoursSince < 22) return;
    }
    console.log('[WatchlistScan] Daily auto-scan triggered…');
    const { rows: companies } = await pool.query('SELECT name FROM companies ORDER BY name');
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    const c = cRows[0] ?? {};
    watchlistScanRunning = true;
    (async () => {
      try {
        for (const co of companies) {
          try {
            const jobs = await scanWatchlistCompanyJobs(pool, co.name, {
              target_roles: c.target_roles ?? [],
              locations:    c.locations    ?? ['Remote'],
            });
            await upsertCompanyJobScan(pool, co.name, jobs);
            console.log(`[WatchlistScan] ${co.name}: ${jobs.length} roles`);
          } catch (e) { console.error(`[WatchlistScan] Error for ${co.name}:`, e); }
        }
        console.log('[WatchlistScan] Daily scan complete');
      } finally { watchlistScanRunning = false; }
    })();
  } catch (e) { console.error('[WatchlistScan] Scheduler error:', e); }
}

// ── Weekly email scheduler ─────────────────────────────────────────────────
async function checkWeeklyEmail(): Promise<void> {
  try {
    const now = new Date();
    // Only send on Mondays (getDay() === 1)
    if (now.getDay() !== 1) return;

    // Check configured send time (default 07:00)
    const { rows: timeRows } = await pool.query("SELECT value FROM settings WHERE key='digest_time' LIMIT 1");
    const sendTime: string = timeRows[0]?.value || '07:00';
    const [sendH, sendM] = sendTime.split(':').map(Number);
    const nowH = now.getHours();
    const nowM = now.getMinutes();
    if (nowH < sendH || (nowH === sendH && nowM < sendM)) return; // too early

    // Check if we already sent this week (within last 6 days)
    const { rows: sentRows } = await pool.query("SELECT value FROM settings WHERE key='last_weekly_email_sent' LIMIT 1");
    if (sentRows[0]?.value) {
      const lastSent = new Date(sentRows[0].value as string);
      const daysSince = (now.getTime() - lastSent.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 6) return; // already sent this week
    }

    // Check Gmail connected and user email set
    const { rows: cRows } = await pool.query('SELECT your_email FROM criteria LIMIT 1');
    const email = cRows[0]?.your_email;
    if (!email) return;

    console.log('[WeeklyEmail] Monday triggered — sending weekly scout report…');

    // Pull top 10 matches from the past 7 days
    const { rows: jobs } = await pool.query(
      `SELECT * FROM jobs WHERE match_score >= 50 AND created_at >= NOW() - INTERVAL '7 days' ORDER BY match_score DESC LIMIT 10`
    );

    const narrative = await generateDigestNarrative(jobs);
    const html = buildDigestHtml(jobs, narrative);
    const subject = `JobScout.ai \u2014 Your Weekly Scout Report`;
    const emailResult = await sendGmailEmail(email, subject, html);

    if (emailResult.ok) {
      // Record send time so we don't double-send
      await pool.query(
        `INSERT INTO settings (key, value) VALUES ('last_weekly_email_sent', $1)
         ON CONFLICT (key) DO UPDATE SET value=$1`,
        [now.toISOString()]
      );
      console.log('[WeeklyEmail] ✓ Weekly report sent successfully');
    } else {
      console.warn('[WeeklyEmail] Failed to send weekly report — will retry next scheduler tick if still Monday');
    }
  } catch (e) {
    console.error('[WeeklyEmail] Error:', e instanceof Error ? e.message : e);
  }
}

// ── Auto-run scheduler ─────────────────────────────────────────────────────
async function checkAutoRun(): Promise<void> {
  if (scoutRunning) return;
  try {
    const { rows: cRows } = await pool.query('SELECT id FROM criteria LIMIT 1');
    if (cRows.length === 0) return;
    const { rows: runRows } = await pool.query(
      "SELECT started_at FROM scout_runs WHERE status='completed' ORDER BY started_at DESC LIMIT 1"
    );
    if (runRows.length > 0) {
      const hoursSince = (Date.now() - new Date(runRows[0].started_at).getTime()) / 3_600_000;
      if (hoursSince < AUTO_RUN_THRESHOLD_H) return;
    }
    console.log('[AutoRun] Triggering scheduled scout run…');
    const { rows: newRun } = await pool.query(
      "INSERT INTO scout_runs (status, jobs_found) VALUES ('running', 0) RETURNING *"
    );
    scoutRunning = true;
    runScoutInBackground(newRun[0].id)
      .catch(console.error)
      .finally(() => { scoutRunning = false; });
  } catch (e) {
    console.error('[AutoRun] Check error:', e);
  }
}

initDb()
  .then(async () => {
    // Auto-reclassify all existing jobs using current tier logic (free, no Claude)
    try {
      const n = await reclassifyJobsLocally();
      if (n > 0) console.log(`Startup reclassify: updated ${n} job tiers to match current logic`);
    } catch (e) { console.warn('Startup reclassify skipped:', e); }

    // Background URL health check + canonical resolution for any unchecked jobs (non-blocking)
    checkUrlHealthInBackground()
      .then(() => runCanonicalResolutionInBackground(pool))
      .catch(() => {});

    // Start auto-scheduler: check immediately after 2 min, then every 15 min
    setTimeout(checkAutoRun, 2 * 60 * 1000);
    setInterval(checkAutoRun, AUTO_RUN_CHECK_MS);

    // Weekly email: check every 15 min (Monday at send-time is the actual gate)
    setInterval(checkWeeklyEmail, 15 * 60 * 1000);

    // Watchlist daily scan: check after 5 min startup delay, then every hour
    setTimeout(checkWatchlistScan, 5 * 60 * 1000);
    setInterval(checkWatchlistScan, 60 * 60 * 1000);

    const server = app.listen(PORT, () => {
      console.log(`Job Scout Agent listening on port ${PORT}`);
    });
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} in use, killing existing process...`);
        import('child_process').then(({ execSync }) => {
          try { execSync(`lsof -ti:${PORT} | xargs kill -9`, { stdio: 'ignore' }); } catch {}
          setTimeout(() => {
            app.listen(PORT, () => {
              console.log(`Job Scout Agent listening on port ${PORT}`);
            });
          }, 1000);
        });
      } else {
        throw err;
      }
    });
  })
  .catch((err: unknown) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// ── HTML constant ─────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Scout Agent</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f0f0f;--surface:#161616;--border:#252525;--text:#e8e6e0;--muted:#666;--gold:#c8a96e;--green:#4caf88;--red:#cf6679;--r:10px}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;min-height:100vh;display:flex;flex-direction:column}

/* header */
header{border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.logo{font-size:17px;font-weight:700;color:var(--gold);letter-spacing:-0.01em}
.hdr-right{margin-left:auto;display:flex;align-items:center;gap:12px}
.hdr-status{font-size:12px;color:var(--muted)}
.gmail-badge{font-size:11px;padding:3px 10px;border-radius:12px;font-weight:600}
.gmail-badge.on{background:#0d2318;color:var(--green)}
.gmail-badge.off{background:#2a1018;color:var(--red)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0}
.dot.running{background:var(--gold);animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

/* stats bar */
.stats-bar{display:flex;gap:0;border-bottom:1px solid var(--border);overflow-x:auto}
.stat{flex:1;padding:14px 24px;border-right:1px solid var(--border);min-width:140px}
.stat:last-child{border-right:none}
.stat-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}
.stat-val{font-size:22px;font-weight:700;color:var(--gold);margin-top:2px}

/* run bar */
.run-bar{padding:14px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:7px;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:opacity .15s;text-decoration:none}
.btn:hover:not(:disabled){opacity:.8}
.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-gold{background:var(--gold);color:#0f0f0f}
.btn-ghost{background:var(--surface);color:var(--text);border:1px solid var(--border)}
.btn-red{background:var(--red);color:#fff}
.btn-sm{padding:5px 12px;font-size:12px}
.run-msg{font-size:12px;color:var(--muted)}
.run-stage{font-size:11px;color:var(--gold);margin-left:4px;font-style:italic}
.run-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.auto-run-badge{font-size:11px;color:var(--muted);padding:3px 9px;border:1px solid #2a2a2a;border-radius:20px;margin-left:auto;white-space:nowrap}
/* Quick-link job site pills */
.quick-links{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.quick-link-sep{width:1px;height:16px;background:var(--border);flex-shrink:0;margin:0 2px}
.ql-btn{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:20px;font-size:11.5px;font-weight:500;color:#aaa;background:transparent;border:1px solid #2a2a2a;text-decoration:none;white-space:nowrap;cursor:pointer;transition:background .12s,color .12s,border-color .12s;user-select:none}
.ql-btn:hover{color:#fff;border-color:#444;background:#1e1e1e}
.ql-btn img{width:13px;height:13px;border-radius:2px;object-fit:contain;flex-shrink:0}

/* Outreach modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:10000;display:flex;align-items:center;justify-content:center;padding:16px}
.modal-box{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:100%;max-width:540px;padding:24px;position:relative}
.modal-title{font-size:15px;font-weight:700;margin-bottom:16px;color:var(--text)}
.modal-section{margin-bottom:18px}
.modal-label{font-size:11px;font-weight:700;color:var(--gold);letter-spacing:.06em;text-transform:uppercase;margin-bottom:6px}
.modal-text{background:#111;border:1px solid #282828;border-radius:8px;padding:12px;font-size:13px;line-height:1.65;color:var(--text);white-space:pre-wrap;word-break:break-word;min-height:48px}
.modal-char-count{font-size:10px;color:var(--muted);text-align:right;margin-top:3px}
.modal-close{position:absolute;top:12px;right:14px;background:none;border:none;color:var(--muted);font-size:18px;cursor:pointer;line-height:1}
.modal-close:hover{color:var(--text)}
.modal-copy-btn{font-size:11px;padding:4px 11px;margin-top:5px}
.modal-spinner{text-align:center;padding:32px;color:var(--muted);font-size:13px}

/* cover letter modal */
.cl-modal-box{background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:660px;max-height:90vh;display:flex;flex-direction:column;position:relative;overflow:hidden}
.cl-modal-header{padding:20px 24px 14px;border-bottom:1px solid var(--border);flex-shrink:0}
.cl-modal-title{font-size:16px;font-weight:700;color:var(--text);margin-bottom:2px}
.cl-modal-sub{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.cl-modal-body{flex:1;overflow-y:auto;padding:0 24px}
.cl-letter-wrap{background:#fafafa;border-radius:10px;padding:28px 32px;margin:20px 0;color:#1a1a1a;font-family:'Georgia',serif;font-size:14.5px;line-height:1.85;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 4px rgba(0,0,0,.12)}
.cl-research-section{margin:0 0 20px}
.cl-research-header{font-size:11px;font-weight:700;color:var(--gold);letter-spacing:.06em;text-transform:uppercase;cursor:pointer;padding:10px 0;display:flex;align-items:center;gap:6px;user-select:none}
.cl-research-list{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-top:6px;display:none}
.cl-research-list.open{display:block}
.cl-research-list li{font-size:12px;color:var(--muted);line-height:1.65;margin-bottom:5px}
.cl-research-list li:last-child{margin-bottom:0}
.cl-modal-footer{padding:14px 24px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;background:var(--surface)}

/* tailor v2 modal */
.tr-modal-box{background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:760px;max-height:92vh;display:flex;flex-direction:column;position:relative;overflow:hidden}
.tr-modal-header{padding:18px 24px 12px;border-bottom:1px solid var(--border);flex-shrink:0}
.tr-modal-title{font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px}
.tr-ats-badge{display:inline-flex;align-items:center;gap:6px;background:rgba(212,175,55,.12);border:1px solid rgba(212,175,55,.3);border-radius:20px;padding:3px 12px;font-size:12px;color:var(--gold);font-weight:600}
.tr-modal-sub{font-size:12px;color:var(--muted);display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:4px}
.tr-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);flex-shrink:0;background:var(--bg)}
.tr-tab{padding:10px 20px;font-size:13px;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:color .12s,border-color .12s;user-select:none}
.tr-tab:hover{color:var(--text)}
.tr-tab.active{color:var(--gold);border-bottom-color:var(--gold);font-weight:600}
.tr-modal-body{flex:1;overflow-y:auto;padding:0 24px}
.tr-resume-wrap{background:#fafafa;border-radius:10px;padding:28px 32px;margin:20px 0;color:#1a1a1a;font-family:'Georgia',serif;font-size:14px;line-height:1.85;white-space:pre-wrap;word-break:break-word;box-shadow:0 1px 4px rgba(0,0,0,.12)}
.tr-section{margin:20px 0}
.tr-section-title{font-size:11px;font-weight:700;color:var(--gold);letter-spacing:.06em;text-transform:uppercase;margin-bottom:10px}
.tr-keyword-grid{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.tr-kw{font-size:12px;padding:3px 10px;border-radius:20px;font-weight:500}
.tr-kw.present{background:rgba(52,211,153,.15);color:#34d399;border:1px solid rgba(52,211,153,.3)}
.tr-kw.missing{background:rgba(248,113,113,.12);color:#f87171;border:1px solid rgba(248,113,113,.25)}
.tr-kw.company{background:rgba(212,175,55,.12);color:var(--gold);border:1px solid rgba(212,175,55,.25)}
.tr-bullet-list{list-style:none;padding:0;margin:0}
.tr-bullet-list li{font-size:13px;color:var(--muted);line-height:1.65;padding:4px 0 4px 18px;position:relative}
.tr-bullet-list li::before{content:attr(data-icon);position:absolute;left:0;color:inherit}
.tr-modal-footer{padding:14px 24px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap;flex-shrink:0;background:var(--surface)}
.tr-progress{text-align:center;padding:40px 24px}
.tr-progress-steps{display:flex;flex-direction:column;gap:10px;margin-top:16px;max-width:320px;margin-left:auto;margin-right:auto}
.tr-step{display:flex;align-items:center;gap:12px;font-size:13px;color:var(--muted);padding:8px 14px;border-radius:8px;border:1px solid var(--border);background:var(--bg)}
.tr-step.active{color:var(--text);border-color:var(--gold);background:rgba(212,175,55,.06)}
.tr-step.done{color:#34d399;border-color:rgba(52,211,153,.3);background:rgba(52,211,153,.05)}
.tr-step-icon{width:20px;text-align:center;flex-shrink:0}
.tr-step-spinner{width:14px;height:14px;border:2px solid rgba(212,175,55,.3);border-top-color:var(--gold);border-radius:50%;animation:spin .8s linear infinite;flex-shrink:0}

/* layout */
.app-body{display:flex;flex:1;min-height:0}

/* sidebar */
.sidebar{width:200px;min-width:200px;border-right:1px solid var(--border);display:flex;flex-direction:column;gap:1px;padding:12px 10px;background:var(--bg)}
.sidebar .tab{padding:7px 12px 7px 18px;font-size:13px;color:var(--muted);cursor:pointer;border-radius:7px;user-select:none;white-space:nowrap;border-left:3px solid transparent;transition:background .12s,color .12s;position:relative}
.sidebar .tab:hover{background:var(--surface);color:var(--text)}
.sidebar .tab.active{color:var(--text);background:var(--surface);border-left-color:var(--gold)}
.nav-group{display:flex;flex-direction:column;gap:1px;margin-bottom:2px}
.nav-group-label{font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#888;padding:14px 10px 5px;user-select:none;border-top:1px solid rgba(255,255,255,.06);margin:0 4px}
.nav-group:first-child .nav-group-label{padding-top:4px;border-top:none}
/* sidebar tooltips */
.sidebar .tab[data-tooltip]::after{content:attr(data-tooltip);position:absolute;left:calc(100% + 14px);top:50%;transform:translateY(-50%);background:#0e0e0e;border:1px solid var(--border);border-radius:9px;padding:11px 14px;font-size:12px;line-height:1.65;color:var(--text);width:270px;white-space:normal;z-index:9999;opacity:0;pointer-events:none;transition:opacity .12s ease .25s;box-shadow:0 8px 28px rgba(0,0,0,.55);font-weight:400}
.sidebar .tab[data-tooltip]:hover::after{opacity:1}

/* main content */
.main-content{flex:1;min-width:0;overflow-y:auto}
.panel{display:none;padding:24px}
.panel.active{display:block}

@media(max-width:700px){.sidebar{width:56px;min-width:56px;padding:12px 4px}.sidebar .tab{font-size:0;padding:10px}.sidebar .tab::before{font-size:16px}.sidebar .tab[data-label]::before{content:attr(data-icon)}}

/* sub-tab */
.sub-tab{font-size:12px!important;color:var(--muted)!important;padding-left:24px!important}
.sub-tab.active{color:var(--text)!important}

/* jobs inner tabs */
.inner-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:16px;flex-wrap:wrap}
.inner-tab{padding:9px 16px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:color .12s;white-space:nowrap}
.inner-tab:hover{color:var(--text)}
.inner-tab.active{color:var(--gold);border-bottom-color:var(--gold)}
.inner-tab.tier-target.active{color:#f5c842;border-bottom-color:#f5c842}
.inner-tab.tier-win.active{color:#00c86e;border-bottom-color:#00c86e}
.inner-tab.tier-stretch.active{color:#7c8dff;border-bottom-color:#7c8dff}
.inner-tab.tier-skip.active{color:#888;border-bottom-color:#888}
.tier-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:5px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.tier-top-target{background:rgba(245,200,66,.15);color:#f5c842;border:1px solid rgba(245,200,66,.35)}
.tier-fast-win{background:rgba(0,200,110,.13);color:#00c86e;border:1px solid rgba(0,200,110,.3)}
.tier-stretch-role{background:rgba(124,141,255,.13);color:#7c8dff;border:1px solid rgba(124,141,255,.3)}
.tier-probably-skip{background:rgba(150,150,150,.1);color:#888;border:1px solid rgba(150,150,150,.25)}
.card.card-top-target{border-left:3px solid #f5c842}
.card.card-fast-win{border-left:3px solid #00c86e}
.card.card-stretch-role{border-left:3px solid #7c8dff}
.card.card-probably-skip{border-left:3px solid #444;opacity:.85}
.sub-scores{padding:10px 18px;border-bottom:1px solid #1e1e1e;display:none}
.sub-scores.open{display:block}
.sub-score-grid{display:grid;grid-template-columns:1fr 1fr;gap:5px 16px}
.sub-score-row{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--muted)}
.sub-score-label{min-width:110px;color:#888}
.sub-score-bar{flex:1;height:4px;background:#222;border-radius:2px;overflow:hidden}
.sub-score-fill{height:100%;border-radius:2px;transition:width .3s}
.sub-score-val{min-width:18px;text-align:right;color:var(--text);font-size:10px;font-weight:600}
.sub-score-toggle{cursor:pointer;font-size:10px;color:var(--muted);padding:2px 8px;border-radius:4px;border:1px solid #2a2a2a;background:transparent;transition:border-color .15s}
.sub-score-toggle:hover{border-color:#444;color:var(--text)}
/* ── Opportunity Scorecard mini indicators (on-card) ─── */
.sc-mini{padding:0 14px 8px;display:grid;grid-template-columns:1fr 1fr;gap:4px 14px}
.sc-mini-item{display:flex;align-items:center;gap:6px;font-size:10px;color:var(--muted)}
.sc-mini-lbl{width:72px;white-space:nowrap;flex-shrink:0;font-weight:600;color:#666}
.sc-mini-bar{flex:1;height:3px;background:#1e1e1e;border-radius:2px;overflow:hidden}
.sc-mini-fill{height:100%;border-radius:2px;transition:width .3s}
.sc-mini-val{width:26px;text-align:right;font-weight:700;font-size:10px}
/* Recommended next step chip */
.rec-step{display:inline-flex;align-items:center;gap:4px;padding:2px 9px;border-radius:4px;font-size:10px;font-weight:700;white-space:nowrap;border:1px solid}
/* Scorecard research tab */
.sc-tab-header{margin:0 0 16px}
.sc-overall{display:flex;align-items:center;gap:16px;padding:14px 16px;background:#111;border-radius:8px;margin-bottom:16px}
.sc-overall-score{font-size:36px;font-weight:900;line-height:1}
.sc-overall-right{flex:1}
.sc-overall-tier{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.sc-overall-rec{font-size:12px;color:var(--muted)}
.sc-rec-chip{display:inline-block;padding:4px 14px;border-radius:6px;font-size:12px;font-weight:700;margin:2px 0}
.sc-section-label{font-size:10px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:.1em;margin:16px 0 8px}
.sc-dim-grid{display:flex;flex-direction:column;gap:6px}
.sc-dim-row{background:#0f0f0f;border:1px solid #1a1a1a;border-radius:6px;padding:9px 12px}
.sc-dim-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
.sc-dim-label{font-size:11px;font-weight:700;color:#aaa}
.sc-dim-score-val{font-size:12px;font-weight:800}
.sc-dim-bar-bg{height:3px;background:#1e1e1e;border-radius:2px}
.sc-dim-bar-fill{height:100%;border-radius:2px;transition:width .4s}
.sc-dim-desc{font-size:10px;color:#555;margin-top:4px}
.sc-list-item{font-size:12px;margin:4px 0;padding-left:18px;position:relative;line-height:1.4}
.sc-list-item.strength{color:var(--green)}.sc-list-item.strength:before{content:"✓";position:absolute;left:0;color:var(--green)}
.sc-list-item.risk{color:#ff9f43}.sc-list-item.risk:before{content:"⚠";position:absolute;left:0;color:#ff9f43}
/* Sort selector */
.jobs-sort-bar{display:flex;align-items:center;gap:8px;padding:6px 20px;border-bottom:1px solid var(--border);background:var(--bg)}
.sort-sel{background:var(--surface);color:var(--muted);border:1px solid var(--border);border-radius:6px;padding:3px 8px;font-size:11px;cursor:pointer;outline:none;appearance:none;-webkit-appearance:none}
.sort-sel:hover{border-color:var(--gold);color:var(--text)}
.rescore-banner{margin:0 0 16px;padding:12px 16px;background:rgba(245,200,66,.08);border:1px solid rgba(245,200,66,.25);border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:12px}
.rescore-banner.hidden{display:none}
.rescore-msg{font-size:13px;color:#ccc}
.rescore-msg strong{color:var(--gold)}
.rescore-progress{font-size:11px;color:var(--muted);margin-top:2px}
.new-badge{display:inline-block;background:var(--gold);color:#0f0f0f;font-size:9px;font-weight:700;padding:1px 6px;border-radius:3px;margin-left:6px;text-transform:uppercase;vertical-align:middle;letter-spacing:.04em}
.save-btn{background:none;border:1px solid var(--border);color:var(--muted);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;transition:all .15s}
.save-btn:hover{border-color:var(--gold);color:var(--gold)}
.save-btn.saved{background:var(--gold);color:#0f0f0f;border-color:var(--gold)}
.saved-date{font-size:10px;color:var(--muted);margin-top:4px}
.track-status-sel{background:var(--surface);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font-size:12px;cursor:pointer;appearance:none;-webkit-appearance:none;min-width:110px;outline:none}
.track-status-sel:hover{border-color:var(--gold);color:var(--gold)}

/* jobs */
.jobs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;margin-top:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.card-head{padding:16px 18px 12px;border-bottom:1px solid #1e1e1e}

/* ── Redesigned card components ─── */
.card-tier-row{display:flex;align-items:center;justify-content:space-between;padding:13px 16px 0}
.score-chip{font-size:19px;font-weight:800;color:var(--gold);line-height:1;min-width:36px;text-align:right}
.score-chip.score-green{color:var(--green)}
.score-chip.score-yellow{color:#f5c842}
.score-chip.score-red{color:var(--red)}
.card-title-block{padding:7px 16px 10px}
.card-v2-title{font-size:15px;font-weight:700;line-height:1.3;color:var(--text)}
.card-co-line{font-size:12px;color:var(--muted);margin-top:3px;display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.card-co-name{color:var(--gold);font-weight:600}
.new-pill{background:rgba(76,175,136,.18);color:var(--green);border:1px solid rgba(76,175,136,.3);border-radius:10px;padding:1px 7px;font-size:10px;font-weight:700}
.card-signal{margin:0 14px 10px;background:rgba(200,169,110,.07);border:1px solid rgba(200,169,110,.2);border-radius:8px;padding:10px 12px}
.signal-label{font-size:10px;font-weight:700;color:var(--gold);letter-spacing:.07em;text-transform:uppercase;margin-bottom:5px;display:flex;align-items:center;gap:5px}
.signal-text{font-size:12.5px;line-height:1.65;color:var(--text)}
.card-meta-strip{padding:8px 16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center;border-top:1px solid #1c1c1c}
.meta-salary{color:var(--green);font-size:12px;font-weight:600}
.card-foot{padding:10px 14px 13px;display:flex;gap:7px;flex-wrap:wrap;align-items:center}
.btn-reach{background:rgba(124,141,255,.12);color:#7c8dff;border:1px solid rgba(124,141,255,.3)}
.btn-reach:hover{background:rgba(124,141,255,.22)}
.btn-apply{background:var(--gold);color:#0f0f0f;font-weight:700}
.btn-link-warn{background:rgba(229,83,83,.15)!important;color:#e55353!important;border:1px solid rgba(229,83,83,.4)!important}
.score-row{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.score-val{color:var(--gold);font-size:13px;font-weight:600}
.bar-bg{height:3px;background:#222;border-radius:2px}
.bar-fg{height:3px;border-radius:2px}
.job-title{font-size:15px;font-weight:600;margin:10px 0 3px}
.job-co{font-size:13px;color:var(--gold)}
.card-meta{padding:9px 18px;border-bottom:1px solid #1e1e1e;font-size:12px;color:var(--muted);display:flex;gap:12px;flex-wrap:wrap}
.card-why{padding:12px 18px;border-bottom:1px solid #1e1e1e;font-size:12px;color:#999;line-height:1.6}
.card-foot{padding:12px 18px;display:flex;gap:8px;flex-wrap:wrap}
.source-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:600;text-transform:uppercase;background:#222;color:var(--muted)}
.source-badge[data-src="LinkedIn"]{background:#0a66c2;color:#fff}
.source-badge[data-src="Indeed"]{background:#003a9b;color:#fff}
.source-badge[data-src="Glassdoor"]{background:#0caa41;color:#fff}
.source-badge[data-src="ZipRecruiter"]{background:#2164f3;color:#fff}
.source-badge[data-src="Greenhouse"]{background:#1a6b3a;color:#fff}
.source-badge[data-src="Lever"]{background:#5c48e4;color:#fff}
.source-badge[data-src="Workday"]{background:#f05a28;color:#fff}
.age-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:500;background:transparent;color:var(--muted);border:1px solid #333}
.ai-risk-badge{display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.ai-risk-LOW{background:rgba(0,200,110,.12);color:#00c86e;border:1px solid rgba(0,200,110,.3)}
.ai-risk-MEDIUM{background:rgba(255,180,0,.12);color:#ffb400;border:1px solid rgba(255,180,0,.3)}
.ai-risk-HIGH{background:rgba(255,70,70,.15);color:#ff4646;border:1px solid rgba(255,70,70,.3)}
.salary-estimated{color:#d4a843;font-size:12px}
.salary-estimated .est-prefix{opacity:0.7;font-size:10px}
.salary-tooltip{position:relative;cursor:help}
.salary-tooltip .tooltip-text{visibility:hidden;position:absolute;bottom:120%;left:50%;transform:translateX(-50%);background:#222;color:#ccc;padding:6px 10px;border-radius:6px;font-size:11px;white-space:nowrap;z-index:10;border:1px solid #333}
.salary-tooltip:hover .tooltip-text{visibility:visible}
.repvue-link{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#1a1a2e;border:1px solid #333;color:#7c8dff;cursor:pointer;text-decoration:none;transition:border-color .15s,color .15s}
.repvue-link:hover{border-color:#7c8dff;color:#a0b0ff}

/* table */
.tbl{width:100%;border-collapse:collapse}
.tbl th{text-align:left;padding:8px 12px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border)}
.tbl td{padding:10px 12px;font-size:13px;border-bottom:1px solid #1a1a1a;vertical-align:top}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase}
.b-running{background:#2a2010;color:var(--gold)}
.b-completed{background:#0d2318;color:var(--green)}
.b-failed{background:#2a1018;color:var(--red)}

/* forms */
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:820px}
@media(max-width:600px){.form-grid{grid-template-columns:1fr}}
.fg{display:flex;flex-direction:column;gap:6px}
.fg.full{grid-column:1/-1}
label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
textarea,input[type="text"],input[type="email"],input[type="number"],input[type="time"],select{background:var(--surface);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 12px;font-size:13px;font-family:inherit;resize:vertical;outline:none;width:100%}
textarea:focus,input:focus{border-color:var(--gold)}
.hint{font-size:11px;color:var(--muted);margin-top:2px}
.save-row{margin-top:20px;display:flex;align-items:center;gap:12px}
.ok-msg{font-size:12px;color:var(--green)}

/* companies */
.company-list{max-width:720px;margin-bottom:20px}
.company-row{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:7px;margin-bottom:8px}
.company-name{font-weight:600;flex:1}
.company-meta{font-size:12px;color:var(--muted)}
.add-form{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;max-width:640px;margin-top:16px}
@media(max-width:600px){.add-form{grid-template-columns:1fr}}

/* settings */
.settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:700px}
@media(max-width:600px){.settings-grid{grid-template-columns:1fr}}
.input-prefix{display:flex;align-items:center;background:var(--surface);border:1px solid var(--border);border-radius:7px;overflow:hidden}
.input-prefix span{padding:9px 0 9px 12px;color:var(--muted);font-size:13px}
.input-prefix input{border:none;background:transparent;padding-left:4px}
.input-prefix input:focus{border:none;box-shadow:none}
.tag-list{display:flex;flex-wrap:wrap;gap:6px;min-height:28px}
.tag{display:inline-flex;align-items:center;gap:4px;background:var(--surface);border:1px solid var(--border);border-radius:5px;padding:3px 8px;font-size:12px;color:var(--text)}
.tag .x{cursor:pointer;color:var(--muted);font-size:14px;line-height:1}
.tag .x:hover{color:var(--red)}
.co-chip{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;background:var(--surface);border:1px solid var(--border);border-radius:6px;font-size:12px;color:var(--text);cursor:pointer;user-select:none;transition:border-color .15s,background .15s}
.co-chip:hover{border-color:var(--gold);color:var(--gold)}
.co-chip input[type=checkbox]{accent-color:var(--gold);cursor:pointer}
.co-chip:has(input:checked){background:#2a220a;border-color:var(--gold);color:var(--gold)}
.hint{font-size:9px;text-transform:none;letter-spacing:0;color:var(--muted);font-weight:400}

.empty{padding:48px;text-align:center;color:var(--muted);font-size:13px}
.sec-title{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}

/* modal */
.modal-overlay{display:none;position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.7);z-index:1000;align-items:center;justify-content:center}
.modal-overlay.show{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:12px;width:90%;max-width:720px;max-height:85vh;overflow-y:auto;padding:24px}
.modal-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px}
.modal-close{background:none;border:none;color:var(--muted);font-size:24px;cursor:pointer;padding:4px}
.modal-close:hover{color:var(--text)}
.modal-section{margin-bottom:20px}
.modal-section h3{font-size:13px;color:var(--gold);text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px}
.modal-text{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;font-size:13px;line-height:1.7;white-space:pre-wrap;color:var(--text);max-height:300px;overflow-y:auto}
.copy-btn{margin-top:8px}

/* resume split */
.resume-split{display:grid;grid-template-columns:1fr 1fr;gap:20px}
@media(max-width:800px){.resume-split{grid-template-columns:1fr}}
.resume-col{display:flex;flex-direction:column}
/* resume toolbar */
.resume-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
.resume-dropdown-wrap{position:relative;display:inline-block}
.resume-dropdown{position:absolute;top:calc(100% + 4px);left:0;min-width:280px;background:var(--surface);border:1px solid var(--border);border-radius:8px;z-index:100;box-shadow:0 8px 32px rgba(0,0,0,.35);overflow:hidden}
.resume-dropdown-item{display:flex;align-items:center;justify-content:space-between;padding:10px 14px;font-size:13px;cursor:pointer;color:var(--text)}
.resume-dropdown-item:hover{background:var(--bg)}
.resume-dropdown-item.active-r{border-left:3px solid var(--gold)}
.resume-dropdown-empty{padding:12px 14px;color:var(--muted);font-size:12px}
.resume-dd-name{font-weight:600;flex:1}
.resume-dd-preview{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
.resume-dd-del{background:none;border:none;color:var(--muted);cursor:pointer;padding:2px 6px;border-radius:4px;font-size:14px}
.resume-dd-del:hover{color:var(--red)}
/* save-name modal */
.save-name-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
/* formatted resume output */
.resume-rendered{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:20px;font-size:13px;line-height:1.75;color:var(--text);max-height:600px;overflow-y:auto}
.resume-rendered h1{font-size:20px;font-weight:700;color:var(--text);margin:0 0 4px}
.resume-rendered h2{font-size:13px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.08em;margin:16px 0 6px;border-bottom:1px solid var(--border);padding-bottom:4px}
.resume-rendered h3{font-size:13px;font-weight:600;color:var(--text);margin:10px 0 4px}
.resume-rendered p{margin:0 0 6px;white-space:pre-wrap}
.resume-rendered ul{margin:0 0 8px;padding-left:20px}
.resume-rendered li{margin-bottom:3px}
.resume-rendered strong{color:var(--text);font-weight:700}
/* upload zone */
.upload-zone{border:2px dashed var(--border);border-radius:8px;padding:12px 16px;display:flex;align-items:center;gap:10px;cursor:pointer;color:var(--muted);font-size:12px;transition:border-color .2s}
.upload-zone:hover{border-color:var(--gold);color:var(--text)}
/* page target toggle */
.page-toggle{display:flex;gap:0;border:1px solid var(--border);border-radius:6px;overflow:hidden}
.page-toggle-btn{padding:5px 14px;font-size:12px;font-weight:600;background:transparent;border:none;color:var(--muted);cursor:pointer;transition:all .15s}
.page-toggle-btn.active{background:var(--gold);color:#000}
/* tailoring analysis panel */
.tailor-analysis{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:12px}
.tailor-analysis-title{font-size:11px;font-weight:700;color:var(--gold);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px}
.tailor-kw-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px}
.tailor-kw{background:rgba(201,163,71,.15);border:1px solid rgba(201,163,71,.3);color:var(--gold);border-radius:4px;padding:2px 8px;font-size:11px;font-weight:600}
.tailor-kw.pref{background:rgba(100,116,139,.15);border-color:rgba(100,116,139,.3);color:#94a3b8}
.tailor-kw.method{background:rgba(139,92,246,.15);border-color:rgba(139,92,246,.3);color:#a78bfa}
.tailor-kw.signal{background:rgba(74,222,128,.1);border-color:rgba(74,222,128,.3);color:#4ade80}
.tailor-signal-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.tailor-page-badge{display:inline-flex;align-items:center;gap:4px;background:var(--bg);border:1px solid var(--border);border-radius:4px;padding:3px 8px;font-size:11px;color:var(--muted);margin-top:8px}
.model-pick-btn{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 18px;cursor:pointer;text-align:left;transition:border-color .15s,background .15s;color:var(--text);min-width:200px}
.model-pick-btn:hover{border-color:var(--gold);background:#1c1608}
.model-pick-btn.active{border-color:var(--gold);background:#1c1608;box-shadow:0 0 0 1px var(--gold)}
@media print{body *{visibility:hidden}.print-target,.print-target *{visibility:visible}.print-target{position:fixed;top:0;left:0;width:100%;background:#fff;color:#000;padding:40px;font-size:13px;line-height:1.7}.print-target h1{font-size:22px;font-weight:700;margin-bottom:4px}.print-target h2{font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin:16px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}.print-target h3{font-size:13px;font-weight:600;margin:10px 0 4px}.print-target ul{padding-left:20px}.print-target li{margin-bottom:3px}}

/* career intel */
.intel-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.intel-meta{font-size:11px;color:var(--muted);margin-top:2px}
.intel-section-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin:24px 0 10px}
.intel-market-summary{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 18px;font-size:13px;line-height:1.7;color:var(--text);margin-bottom:4px}
.intel-themes-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-bottom:4px}
.intel-theme-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
.intel-theme-name{font-size:12px;font-weight:700;color:var(--gold);margin-bottom:6px}
.intel-theme-body{font-size:12px;color:var(--text);line-height:1.6;margin-bottom:6px}
.intel-theme-why{font-size:11px;color:var(--muted);line-height:1.5}
.intel-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
.intel-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s}
.intel-card:hover{border-color:var(--gold)}
.intel-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.intel-company-name{font-size:14px;font-weight:700;color:var(--text)}
.intel-company-url{font-size:11px;color:var(--muted);text-decoration:none;display:block;margin-top:2px}
.intel-company-url:hover{color:var(--gold)}
.intel-action-badge{flex-shrink:0;padding:3px 9px;border-radius:5px;font-size:11px;font-weight:700;white-space:nowrap}
.intel-action-target{background:#f5c84222;color:#f5c842;border:1px solid #f5c84244}
.intel-action-network{background:#7c8dff22;color:#7c8dff;border:1px solid #7c8dff44}
.intel-action-watch{background:#00c86e22;color:#00c86e;border:1px solid #00c86e44}
.intel-action-skip{background:#88888822;color:#888;border:1px solid #88888844}
.intel-card-section{display:flex;flex-direction:column;gap:3px}
.intel-card-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.intel-card-value{font-size:12px;color:var(--text);line-height:1.6}
.intel-roles-list{display:flex;flex-wrap:wrap;gap:5px;margin-top:2px}
.intel-role-chip{font-size:11px;background:#ffffff0d;border:1px solid var(--border);border-radius:4px;padding:2px 8px;color:var(--muted)}
.intel-confidence{display:flex;align-items:center;gap:8px;margin-top:2px}
.intel-confidence-bar{flex:1;height:4px;background:#ffffff15;border-radius:2px;overflow:hidden}
.intel-confidence-fill{height:100%;background:var(--gold);border-radius:2px;transition:width .3s}
.intel-confidence-val{font-size:11px;color:var(--muted);white-space:nowrap}
.intel-risk-flags{display:flex;flex-direction:column;gap:3px}
.intel-risk-flag{font-size:11px;color:#ff6b6b;padding-left:12px;position:relative;line-height:1.5}
.intel-risk-flag::before{content:'!';position:absolute;left:0;color:#ff6b6b;font-weight:700}
.intel-citations{display:flex;flex-direction:column;gap:4px}
.intel-citation-link{font-size:11px;color:var(--muted);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:block}
.intel-citation-link:hover{color:var(--gold)}
.intel-card-divider{height:1px;background:var(--border);margin:2px 0}
.intel-loading-wrap{display:flex;align-items:center;gap:16px;padding:48px 0;justify-content:center}
.intel-spinner{width:22px;height:22px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
.intel-loading-msg{font-size:13px;color:var(--muted);line-height:1.6}
.intel-error-box{background:#ff6b6b18;border:1px solid #ff6b6b44;border-radius:8px;padding:14px 16px;font-size:13px;color:#ff6b6b;margin-bottom:16px}
.intel-footer{font-size:11px;color:var(--muted);margin-top:20px;padding-top:14px;border-top:1px solid var(--border)}

/* ── Job Market Pulse ─────────────────────────────────────────────────────── */
.pulse-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.pulse-cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px;margin-top:8px}
.pulse-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s,box-shadow .15s}
.pulse-card:hover{border-color:rgba(200,169,110,.35);box-shadow:0 2px 12px rgba(0,0,0,.3)}
.pulse-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}
.pulse-company-name{font-size:14px;font-weight:700;color:var(--text);line-height:1.3}
.pulse-company-url{font-size:11px;color:var(--muted);text-decoration:none;display:block;margin-top:2px}
.pulse-company-url:hover{color:var(--gold)}
.pulse-signal-badge{flex-shrink:0;padding:4px 10px;border-radius:6px;font-size:11px;font-weight:700;white-space:nowrap;letter-spacing:.04em}
.pulse-sig-true_growth{background:rgba(74,222,128,.12);color:#4ade80;border:1px solid rgba(74,222,128,.3)}
.pulse-sig-cautious{background:rgba(251,191,36,.12);color:#fbbf24;border:1px solid rgba(251,191,36,.3)}
.pulse-sig-hype_risk{background:rgba(249,115,22,.12);color:#f97316;border:1px solid rgba(249,115,22,.3)}
.pulse-sig-desperate_hiring{background:rgba(239,68,68,.12);color:#ef4444;border:1px solid rgba(239,68,68,.3)}
.pulse-sig-ai_risk{background:rgba(168,85,247,.12);color:#a855f7;border:1px solid rgba(168,85,247,.3)}
.pulse-sig-unknown{background:rgba(148,163,184,.1);color:#94a3b8;border:1px solid rgba(148,163,184,.25)}
.pulse-sig-chip{padding:3px 9px;border-radius:5px;font-size:10px;font-weight:700;cursor:default}
.pulse-rec-badge{font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.05em}
.pulse-rec-pursue{background:rgba(74,222,128,.15);color:#4ade80}
.pulse-rec-watch{background:rgba(251,191,36,.15);color:#fbbf24}
.pulse-rec-caution{background:rgba(249,115,22,.15);color:#f97316}
.pulse-rec-avoid{background:rgba(239,68,68,.15);color:#ef4444}
.pulse-section-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:4px}
.pulse-section-value{font-size:12px;color:var(--text);line-height:1.65}
.pulse-agent-box{background:#0d0d0d;border:1px solid rgba(200,169,110,.2);border-radius:8px;padding:12px 14px}
.pulse-agent-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--gold);margin-bottom:6px}
.pulse-agent-text{font-size:12px;color:var(--text);line-height:1.7}
.pulse-risk-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
.pulse-risk-chip{font-size:11px;background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#ef4444;border-radius:4px;padding:2px 8px}
.pulse-evidence-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:4px}
.pulse-evidence-chip{font-size:11px;background:rgba(74,222,128,.08);border:1px solid rgba(74,222,128,.2);color:#4ade80;border-radius:4px;padding:2px 8px}
.pulse-scout-row{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:8px 10px;background:#0a0a0a;border-radius:6px;border:1px solid var(--border)}
.pulse-scout-stat{font-size:11px;color:var(--muted)}
.pulse-scout-stat strong{color:var(--text);font-weight:700}
.pulse-stat-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:12px 14px}
.pulse-stat-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--muted);margin-bottom:6px}
.pulse-stat-value{font-size:22px;font-weight:800;color:var(--gold);line-height:1}
.pulse-stat-sub{font-size:11px;color:var(--muted);margin-top:3px}
.pulse-role-bars{margin-top:8px}
.pulse-role-row{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.pulse-role-name{font-size:11px;color:var(--text);min-width:140px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pulse-role-bar-wrap{flex:1;height:5px;background:#ffffff10;border-radius:3px;overflow:hidden}
.pulse-role-bar-fill{height:100%;background:var(--gold);border-radius:3px}
.pulse-role-count{font-size:10px;color:var(--muted);min-width:20px;text-align:right}
.pulse-mood-hot{background:linear-gradient(135deg,rgba(245,199,66,.08),rgba(249,115,22,.05));border:1px solid rgba(245,199,66,.2)}
.pulse-mood-warm{background:linear-gradient(135deg,rgba(74,222,128,.06),rgba(251,191,36,.05));border:1px solid rgba(74,222,128,.15)}
.pulse-mood-cooling{background:linear-gradient(135deg,rgba(148,163,184,.06),rgba(99,102,241,.05));border:1px solid rgba(148,163,184,.15)}
.pulse-mood-mixed{background:linear-gradient(135deg,rgba(200,169,110,.07),rgba(99,102,241,.04));border:1px solid rgba(200,169,110,.15)}
.pulse-citation-link{font-size:10px;color:var(--muted);text-decoration:none;display:inline-block;margin-right:6px;margin-top:4px}
.pulse-citation-link:hover{color:var(--gold)}
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:700px){.intel-cards{grid-template-columns:1fr}.intel-themes-grid{grid-template-columns:1fr}}
/* ── Pre-IPO Intelligence ─────────────────────────────────────────────────── */
.preipo-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.preipo-meta{font-size:11px;color:var(--muted);margin-top:2px}
.preipo-thesis-box{background:linear-gradient(135deg,#1a1600 0%,#0e0e0e 100%);border:1px solid #f5c84266;border-radius:10px;padding:16px 18px;margin-bottom:20px;display:grid;grid-template-columns:auto 1fr;gap:10px 16px;align-items:start}
.preipo-thesis-icon{font-size:28px;line-height:1;margin-top:2px}
.preipo-thesis-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--gold);margin-bottom:5px}
.preipo-thesis-text{font-size:13px;color:var(--text);line-height:1.65}
.preipo-market-ctx{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 18px;font-size:12.5px;line-height:1.7;color:var(--text);margin-bottom:18px}
.preipo-stage-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:18px}
.preipo-stage-btn{padding:5px 14px;font-size:12px;font-weight:600;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;transition:all .13s}
.preipo-stage-btn:hover{border-color:var(--gold);color:var(--text)}
.preipo-stage-btn.active{background:var(--gold);color:#000;border-color:var(--gold)}
.preipo-stage-btn.seriesb{border-color:#f5c84266;color:#f5c842}
.preipo-stage-btn.seriesb.active{background:var(--gold);color:#000}
.preipo-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(350px,1fr));gap:14px}
.preipo-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s;position:relative}
.preipo-card:hover{border-color:var(--gold)}
.preipo-card.is-seriesb{border-color:#f5c84233}
.preipo-card.is-seriesb:hover{border-color:var(--gold)}
.preipo-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.preipo-card-name{font-size:14px;font-weight:700;color:var(--text)}
.preipo-card-url{font-size:11px;color:var(--muted);text-decoration:none;display:block;margin-top:2px}
.preipo-card-url:hover{color:var(--gold)}
.preipo-card-badges{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}
.preipo-stage-badge{padding:3px 9px;border-radius:5px;font-size:11px;font-weight:700;white-space:nowrap}
.preipo-stage-a{background:#7c8dff22;color:#7c8dff;border:1px solid #7c8dff44}
.preipo-stage-b{background:#f5c84222;color:#f5c842;border:1px solid #f5c84244}
.preipo-stage-c{background:#00c86e22;color:#00c86e;border:1px solid #00c86e44}
.preipo-stage-d{background:#ff900022;color:#ff9000;border:1px solid #ff900044}
.preipo-action-badge{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.preipo-action-now{background:#00c86e22;color:#00c86e;border:1px solid #00c86e44}
.preipo-action-watch{background:#f5c84222;color:#f5c842;border:1px solid #f5c84244}
.preipo-action-network{background:#7c8dff22;color:#7c8dff;border:1px solid #7c8dff44}
.preipo-action-monitor{background:#88888822;color:#888;border:1px solid #88888844}
.preipo-momentum{display:flex;align-items:center;gap:8px}
.preipo-momentum-bar{flex:1;height:5px;background:#ffffff12;border-radius:3px;overflow:hidden}
.preipo-momentum-fill{height:100%;border-radius:3px;transition:width .4s}
.preipo-momentum-val{font-size:11px;color:var(--muted);white-space:nowrap;width:36px;text-align:right}
.preipo-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.preipo-val{font-size:12px;color:var(--text);line-height:1.6;margin-top:2px}
.preipo-signals{display:flex;flex-direction:column;gap:3px;margin-top:2px}
.preipo-signal{font-size:11px;color:#00c86e;padding-left:13px;position:relative;line-height:1.5}
.preipo-signal::before{content:'↑';position:absolute;left:0;font-size:10px}
.preipo-risk{font-size:11px;color:#ff6b6b;padding-left:13px;position:relative;line-height:1.5}
.preipo-risk::before{content:'!';position:absolute;left:0;font-weight:700}
.preipo-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:3px}
.preipo-chip{font-size:11px;background:#ffffff0d;border:1px solid var(--border);border-radius:4px;padding:2px 8px;color:var(--muted)}
.preipo-divider{height:1px;background:var(--border);margin:2px 0}
.preipo-cites{display:flex;flex-direction:column;gap:3px;margin-top:2px}
.preipo-cite{font-size:11px;color:var(--muted);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;display:block}
.preipo-cite:hover{color:var(--gold)}
.preipo-footer{font-size:11px;color:var(--muted);margin-top:20px;padding-top:14px;border-top:1px solid var(--border)}
.preipo-empty{padding:48px 0;text-align:center;color:var(--muted);font-size:13px}
.preipo-loading-wrap{display:flex;align-items:center;gap:16px;padding:48px 0;justify-content:center}
.preipo-spinner{width:22px;height:22px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
.preipo-loading-msg{font-size:13px;color:var(--muted);line-height:1.6}
.preipo-error-box{background:#ff6b6b18;border:1px solid #ff6b6b44;border-radius:8px;padding:14px 16px;font-size:13px;color:#ff6b6b;margin-bottom:16px}
.preipo-seriesb-label{display:inline-flex;align-items:center;gap:5px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gold);position:absolute;top:12px;right:12px;opacity:.7}
@media(max-width:700px){.preipo-grid{grid-template-columns:1fr}}
/* ── Industry Leaders ──────────────────────────────────────────────────────── */
.leaders-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.leaders-meta{font-size:11px;color:var(--muted);margin-top:2px}
.leaders-overview{background:linear-gradient(135deg,#0e1a2e 0%,#0e0e0e 100%);border:1px solid #3b82f644;border-radius:10px;padding:16px 18px;margin-bottom:20px;font-size:13px;color:var(--text);line-height:1.65}
.leaders-sector-block{margin-bottom:28px}
.leaders-sector-header{display:flex;align-items:center;gap:10px;margin-bottom:10px;padding-bottom:8px;border-bottom:1px solid var(--border)}
.leaders-sector-emoji{font-size:22px;line-height:1}
.leaders-sector-name{font-size:15px;font-weight:700;color:var(--text)}
.leaders-sector-ctx{font-size:12px;color:var(--muted);margin-top:2px;line-height:1.5}
.leaders-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:12px}
.leaders-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:8px;transition:border-color .15s;position:relative}
.leaders-card:hover{border-color:var(--gold)}
.leaders-card.action-apply{border-left:3px solid #00c86e}
.leaders-card.action-network{border-left:3px solid #7c8dff}
.leaders-card.action-watch{border-left:3px solid #f5c842}
.leaders-card.action-monitor{border-left:3px solid #555}
.leaders-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.leaders-rank{font-size:11px;font-weight:700;color:var(--muted);min-width:20px}
.leaders-name-block{flex:1}
.leaders-name{font-size:14px;font-weight:700;color:var(--text)}
.leaders-url{font-size:11px;color:var(--muted);text-decoration:none;display:block;margin-top:1px}
.leaders-url:hover{color:var(--gold)}
.leaders-badges{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}
.leaders-action-badge{padding:2px 8px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.leaders-action-apply{background:#00c86e22;color:#00c86e;border:1px solid #00c86e44}
.leaders-action-network{background:#7c8dff22;color:#7c8dff;border:1px solid #7c8dff44}
.leaders-action-watch{background:#f5c84222;color:#f5c842;border:1px solid #f5c84244}
.leaders-action-monitor{background:#88888822;color:#888;border:1px solid #88888844}
.leaders-stage-badge{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:#ffffff0f;color:var(--muted);border:1px solid var(--border)}
.leaders-ticker{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;background:#3b82f615;color:#60a5fa;border:1px solid #3b82f633}
.leaders-tagline{font-size:12px;color:var(--text);line-height:1.5}
.leaders-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:2px}
.leaders-val{font-size:12px;color:var(--text);line-height:1.55}
.leaders-signal{font-size:11px;color:#00c86e;padding-left:13px;position:relative;line-height:1.5}
.leaders-signal::before{content:'↑';position:absolute;left:0;font-size:10px}
.leaders-ote{font-size:12px;font-weight:700;color:var(--gold)}
.leaders-divider{height:1px;background:var(--border)}
.leaders-loading-wrap{display:flex;align-items:center;gap:16px;padding:64px 0;justify-content:center}
.leaders-spinner{width:22px;height:22px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
.leaders-loading-msg{font-size:13px;color:var(--muted);line-height:1.6}
.leaders-error-box{background:#ff6b6b18;border:1px solid #ff6b6b44;border-radius:8px;padding:14px 16px;font-size:13px;color:#ff6b6b;margin-bottom:16px}
.leaders-empty{padding:64px 0;text-align:center;color:var(--muted);font-size:13px;line-height:1.7}
.leaders-footer{font-size:11px;color:var(--muted);margin-top:20px;padding-top:14px;border-top:1px solid var(--border)}
@media(max-width:700px){.leaders-grid{grid-template-columns:1fr}}
/* ── Deep Value ────────────────────────────────────────────────────────────── */
.dv-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:16px;flex-wrap:wrap}
.dv-meta{font-size:11px;color:var(--muted);margin-top:2px}
.dv-summary{background:linear-gradient(135deg,#100e00 0%,#0e0e0e 100%);border:1px solid #f5c84233;border-radius:10px;padding:16px 18px;margin-bottom:20px;font-size:13px;color:var(--text);line-height:1.65}
.dv-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px}
.dv-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s}
.dv-card:hover{border-color:var(--gold)}
.dv-card.has-roles{border-left:3px solid #00c86e}
.dv-card.no-roles{border-left:3px solid #333}
.dv-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.dv-name-block{flex:1}
.dv-name{font-size:14px;font-weight:700;color:var(--text)}
.dv-url{font-size:11px;color:var(--muted);text-decoration:none;display:block;margin-top:1px}
.dv-url:hover{color:var(--gold)}
.dv-badges{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex-shrink:0}
.dv-category-badge{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:#f5c84215;color:#f5c842;border:1px solid #f5c84233}
.dv-public-badge{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;background:#3b82f615;color:#60a5fa;border:1px solid #3b82f633}
.dv-private-badge{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:#ffffff0f;color:var(--muted);border:1px solid var(--border)}
.dv-tagline{font-size:12.5px;color:var(--text);line-height:1.5;font-style:italic}
.dv-lbl{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin-bottom:2px}
.dv-val{font-size:12px;color:var(--text);line-height:1.55}
.dv-why{font-size:12px;color:#e2c46a;line-height:1.6;padding:10px 12px;background:#f5c84208;border:1px solid #f5c84220;border-radius:6px}
.dv-signal{font-size:11px;color:#00c86e;padding-left:13px;position:relative;line-height:1.5}
.dv-signal::before{content:'↑';position:absolute;left:0;font-size:10px}
.dv-customers{display:flex;flex-wrap:wrap;gap:5px;margin-top:3px}
.dv-customer-chip{font-size:11px;background:#ffffff0d;border:1px solid var(--border);border-radius:4px;padding:2px 8px;color:var(--muted)}
.dv-divider{height:1px;background:var(--border)}
.dv-roles-section{display:flex;flex-direction:column;gap:6px}
.dv-roles-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#00c86e}
.dv-role-row{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;background:#00c86e0a;border:1px solid #00c86e22;border-radius:6px}
.dv-role-title{font-size:12px;color:var(--text);flex:1}
.dv-role-loc{font-size:11px;color:var(--muted)}
.dv-role-apply{padding:3px 10px;border-radius:5px;font-size:11px;font-weight:700;background:#00c86e22;color:#00c86e;border:1px solid #00c86e44;text-decoration:none;white-space:nowrap}
.dv-role-apply:hover{background:#00c86e33}
.dv-no-roles{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;background:#ffffff05;border:1px solid var(--border);border-radius:6px}
.dv-no-roles-text{font-size:11px;color:var(--muted)}
.dv-watchlist-btn{padding:3px 10px;border-radius:5px;font-size:11px;font-weight:700;background:#f5c84218;color:var(--gold);border:1px solid #f5c84233;cursor:pointer;white-space:nowrap}
.dv-watchlist-btn:hover{background:#f5c84228}
.dv-watchlist-btn.added{background:#00c86e15;color:#00c86e;border-color:#00c86e33;cursor:default}
.dv-cites{display:flex;flex-direction:column;gap:3px}
.dv-cite{font-size:11px;color:var(--muted);text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
.dv-cite:hover{color:var(--gold)}
.dv-loading-wrap{display:flex;align-items:center;gap:16px;padding:64px 0;justify-content:center}
.dv-spinner{width:22px;height:22px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .7s linear infinite;flex-shrink:0}
.dv-loading-msg{font-size:13px;color:var(--muted);line-height:1.6}
.dv-error-box{background:#ff6b6b18;border:1px solid #ff6b6b44;border-radius:8px;padding:14px 16px;font-size:13px;color:#ff6b6b;margin-bottom:16px}
.dv-empty{padding:64px 0;text-align:center;color:var(--muted);font-size:13px;line-height:1.7}
.dv-footer{font-size:11px;color:var(--muted);margin-top:20px;padding-top:14px;border-top:1px solid var(--border)}
/* ── Company Watchlist enhancements ──────────────────────────────────────── */
.cw-job-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px}
.cw-role-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#00c86e15;color:#00c86e;border:1px solid #00c86e33;text-decoration:none}
.cw-role-badge:hover{background:#00c86e22}
.cw-no-roles-badge{font-size:11px;color:var(--muted)}
.cw-scan-status{font-size:11px;color:var(--muted);margin-top:2px}
.cw-scan-header{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:20px;padding:12px 14px;background:var(--surface);border:1px solid var(--border);border-radius:8px}
/* Company Watchlist cards */
.cw-cards-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;margin-bottom:24px}
.cw-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s}
.cw-card:hover{border-color:rgba(200,169,110,.3)}
.cw-card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}
.cw-card-name{font-size:14px;font-weight:700;color:var(--text)}
.cw-card-url{font-size:11px;color:var(--muted);text-decoration:none;display:block;margin-top:2px}
.cw-card-url:hover{color:var(--gold)}
.cw-card-status-verified{color:#4ade80;font-size:11px;font-weight:700}
.cw-card-status-pending{color:#fbbf24;font-size:11px;font-weight:700}
.cw-card-status-failed{color:#ef4444;font-size:11px;font-weight:700}
.cw-card-status-manual{color:var(--muted);font-size:11px;font-weight:600}
.cw-card-careers{display:flex;flex-direction:column;gap:3px;padding:8px 10px;background:#0a0a0a;border-radius:6px;border:1px solid var(--border)}
.cw-card-careers-label{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.cw-card-careers-url{font-size:12px;color:var(--text);word-break:break-all}
.cw-card-jobs{border-top:1px solid var(--border);padding-top:8px}
.cw-card-actions{display:flex;flex-wrap:wrap;gap:6px;margin-top:2px}
/* Universal Save-to-Watchlist button */
.save-watchlist-btn{padding:3px 10px;border-radius:5px;font-size:11px;font-weight:700;background:rgba(200,169,110,.1);color:var(--gold);border:1px solid rgba(200,169,110,.25);cursor:pointer;white-space:nowrap;transition:background .15s}
.save-watchlist-btn:hover{background:rgba(200,169,110,.2)}
.save-watchlist-btn.saved{background:rgba(74,222,128,.1);color:#4ade80;border-color:rgba(74,222,128,.25);cursor:default}
@media(max-width:700px){.dv-grid{grid-template-columns:1fr}}
/* ── Industry News ──────────────────────────────────────────────────────────── */
.news-layout{display:flex;flex-direction:column;height:100%;padding:20px 24px;gap:0;overflow:hidden}
.news-topbar{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:16px;flex-shrink:0}
.news-title{font-size:17px;font-weight:800;color:var(--text);letter-spacing:-.01em}
.news-subtitle{font-size:12px;color:var(--muted);margin-top:1px}
.news-filter-bar{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px;flex-shrink:0}
.news-filter-btn{padding:4px 12px;border-radius:20px;font-size:11px;font-weight:600;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer;transition:all .15s}
.news-filter-btn:hover{border-color:var(--gold);color:var(--gold)}
.news-filter-btn.active{background:rgba(200,169,110,.15);border-color:rgba(200,169,110,.4);color:var(--gold)}
.news-signal-btn{padding:4px 12px;border-radius:20px;font-size:11px;font-weight:700;border:1px solid transparent;cursor:pointer;transition:all .15s}
.news-signal-btn.hiring{background:rgba(74,222,128,.1);color:#4ade80;border-color:rgba(74,222,128,.3)}
.news-signal-btn.hiring.active{background:#4ade8020;box-shadow:0 0 0 1px #4ade80}
.news-signal-btn.funded{background:rgba(245,200,66,.1);color:var(--gold);border-color:rgba(245,200,66,.3)}
.news-signal-btn.funded.active{background:#f5c84220;box-shadow:0 0 0 1px var(--gold)}
.news-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:14px;overflow-y:auto;flex:1;padding-bottom:16px}
.news-card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:10px;transition:border-color .15s;position:relative}
.news-card:hover{border-color:rgba(200,169,110,.35)}
.news-card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
.news-card-company{font-size:13px;font-weight:800;color:var(--text)}
.news-card-source{font-size:10px;color:var(--muted);margin-top:2px}
.news-card-score{font-size:11px;font-weight:800;padding:2px 7px;border-radius:5px;background:rgba(200,169,110,.12);color:var(--gold);flex-shrink:0;align-self:flex-start}
.news-card-title{font-size:12px;color:var(--text);line-height:1.45;font-weight:600}
.news-card-title a{color:inherit;text-decoration:none}
.news-card-title a:hover{color:var(--gold)}
.news-card-divider{border:none;border-top:1px solid var(--border);margin:0}
.news-card-summary{font-size:12px;color:var(--text-secondary, #b0b0b0);line-height:1.5}
.news-card-matters{font-size:11px;color:var(--muted);line-height:1.45;border-left:2px solid rgba(200,169,110,.3);padding-left:8px;font-style:italic}
.news-meta-row{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.news-badge{padding:2px 7px;border-radius:4px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.news-badge-sector{background:rgba(124,141,255,.12);color:#7c8dff;border:1px solid rgba(124,141,255,.2)}
.news-badge-hiring-strong{background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.25)}
.news-badge-hiring-moderate{background:rgba(245,200,66,.1);color:var(--gold);border:1px solid rgba(245,200,66,.25)}
.news-badge-hiring-low,.news-badge-hiring-none,.news-badge-hiring-unknown{background:rgba(120,120,120,.1);color:var(--muted);border:1px solid var(--border)}
.news-badge-funding{background:rgba(245,200,66,.08);color:#e0b840;border:1px solid rgba(245,200,66,.15)}
.news-badge-territory{background:rgba(59,130,246,.1);color:#60a5fa;border:1px solid rgba(59,130,246,.2)}
.news-card-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:2px}
.news-card-age{font-size:10px;color:var(--muted);margin-left:auto}
.news-empty{text-align:center;color:var(--muted);padding:60px 20px;grid-column:1/-1}
.news-loading{text-align:center;color:var(--muted);padding:60px 20px;grid-column:1/-1}
.news-footer{font-size:11px;color:var(--muted);text-align:center;padding-top:8px;flex-shrink:0}
.news-status{font-size:12px;color:var(--muted);margin-top:2px}
@media(max-width:700px){.news-grid{grid-template-columns:1fr}}
/* ── Positioning Engine ────────────────────────────────────────────────────── */
.pos-layout{display:flex;flex-direction:column;height:100%;padding:24px;gap:20px;max-width:1100px}
.pos-steps{display:flex;gap:6px;flex-wrap:wrap}
.pos-step-btn{padding:8px 16px;border-radius:20px;border:1px solid var(--border);background:var(--surface);color:var(--muted);font-size:13px;cursor:pointer;transition:all .15s}
.pos-step-btn:hover{color:var(--text);border-color:var(--gold)}
.pos-step-btn.active{background:var(--gold);color:#000;border-color:var(--gold);font-weight:600}
.pos-section{display:none;flex-direction:column;gap:20px}
.pos-section.active{display:flex}
.pos-section-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap}
.pos-title{font-size:20px;font-weight:700;margin:0 0 4px}
.pos-sub{font-size:13px;color:var(--muted);margin:0}
.pos-req{color:var(--gold)}
.pos-form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pos-field{display:flex;flex-direction:column;gap:6px}
.pos-full{grid-column:1/-1}
.pos-label{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
.pos-input{background:var(--surface);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:10px 12px;font-size:14px;outline:none;width:100%;box-sizing:border-box}
.pos-input:focus,.pos-textarea:focus{border-color:var(--gold)}
.pos-textarea{background:var(--surface);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:10px 12px;font-size:13px;outline:none;width:100%;box-sizing:border-box;resize:vertical;font-family:inherit;line-height:1.5}
.pos-gen-status{padding:12px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;font-size:13px;color:var(--muted)}
.pos-outputs-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pos-output-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px;display:flex;flex-direction:column;gap:10px}
.pos-output-label{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--gold)}
.pos-output-text{font-size:13px;line-height:1.6;color:var(--text);white-space:pre-wrap;flex:1}
.pos-output-copy{align-self:flex-end;padding:4px 12px;font-size:11px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--muted);cursor:pointer}
.pos-output-copy:hover{color:var(--text);border-color:var(--gold)}
.pos-story-list{display:flex;flex-direction:column;gap:10px}
.pos-story-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;display:flex;gap:14px;align-items:flex-start}
.pos-story-body{flex:1;min-width:0}
.pos-story-title{font-size:14px;font-weight:600;margin-bottom:4px}
.pos-story-car{font-size:12px;color:var(--muted);line-height:1.5}
.pos-story-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.pos-story-tag{background:var(--gold)22;border:1px solid var(--gold)44;color:var(--gold);border-radius:10px;padding:2px 8px;font-size:11px}
.pos-story-conf{font-size:11px;color:var(--muted);margin-top:4px}
.pos-story-actions{display:flex;gap:6px;flex-shrink:0}
.pos-theme-pills{display:flex;gap:8px;flex-wrap:wrap}
.pos-theme-pill{display:flex;align-items:center;gap:5px;padding:5px 10px;border:1px solid var(--border);border-radius:12px;cursor:pointer;font-size:12px;color:var(--muted);user-select:none}
.pos-theme-pill input{accent-color:var(--gold)}
.pos-theme-pill:hover{border-color:var(--gold);color:var(--text)}
.pos-obj-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:16px 18px;display:flex;flex-direction:column;gap:10px;margin-bottom:12px}
.pos-obj-title{font-size:15px;font-weight:600;color:var(--text)}
.pos-obj-row{display:flex;gap:10px}
.pos-obj-key{font-size:11px;font-weight:700;text-transform:uppercase;color:var(--gold);min-width:110px;padding-top:1px}
.pos-obj-val{font-size:13px;color:var(--text);line-height:1.5;flex:1}
.pos-narr-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.pos-narr-field{display:flex;flex-direction:column;gap:6px}
.pos-narr-full{grid-column:1/-1}
.pos-approved-badge{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:#22c55e22;border:1px solid #22c55e55;border-radius:20px;color:#22c55e;font-size:12px;font-weight:600}
.pos-empty{color:var(--muted);font-size:13px;padding:20px;text-align:center;border:1px dashed var(--border);border-radius:8px}
@media(max-width:700px){.pos-form-grid,.pos-outputs-grid,.pos-narr-grid{grid-template-columns:1fr}.pos-full,.pos-narr-full{grid-column:1}}

/* clawd iframe panel */
#panel-clawd{padding:0!important}
#panel-clawd.active{display:block}
.clawd-frame{width:100%;border:none;display:block}
/* email tab */
.email-section{max-width:100%}
.email-toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 16px;background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:16px;font-size:12px}
.toolbar-sep{width:1px;height:18px;background:var(--border);flex-shrink:0}
.email-preview{background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:16px;max-height:calc(100vh - 260px);overflow-y:auto}

/* research modal */
.research-modal{max-width:800px;width:95%}
.research-header{text-align:center;padding-bottom:16px;border-bottom:1px solid var(--border);margin-bottom:0}
.research-company-name{font-size:22px;font-weight:700;color:var(--text);margin-bottom:4px}
.research-oneliner{font-size:13px;color:var(--muted);margin-bottom:12px}
.research-chips{display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin-bottom:8px}
.research-chip{background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:4px 12px;font-size:12px;color:var(--text)}
.research-chip .chip-label{color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.05em;display:block}
.research-chip .chip-val{font-weight:600;color:var(--gold)}
.research-meta{font-size:11px;color:var(--muted);text-align:center;margin-top:8px}
.research-meta a{color:var(--gold);cursor:pointer;text-decoration:underline}
.research-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);overflow-x:auto;margin-bottom:16px}
.research-tab{padding:10px 16px;font-size:12px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:color .12s}
.research-tab:hover{color:var(--text)}
.research-tab.active{color:var(--gold);border-bottom-color:var(--gold)}
.research-body{padding:0 4px;min-height:200px}
.research-body h4{font-size:12px;color:var(--gold);text-transform:uppercase;letter-spacing:.08em;margin:16px 0 8px}
.research-body h4:first-child{margin-top:0}
.research-body p{font-size:13px;color:var(--text);line-height:1.7;margin-bottom:12px}
.research-body ol{list-style:none;counter-reset:tp;padding:0;margin:0}
.research-body ol li{counter-increment:tp;padding:10px 12px;background:var(--bg);border:1px solid var(--border);border-radius:7px;margin-bottom:8px;font-size:13px;line-height:1.6;color:var(--text);position:relative;padding-left:36px}
.research-body ol li::before{content:counter(tp);position:absolute;left:12px;top:10px;color:var(--gold);font-weight:700;font-size:14px}
.research-body ul{list-style:none;padding:0;margin:0}
.research-body ul li{padding:6px 0;font-size:13px;color:var(--text);border-bottom:1px solid #1e1e1e}
.research-body ul li:last-child{border-bottom:none}
.research-tags{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.research-tag{background:var(--bg);border:1px solid var(--border);border-radius:5px;padding:4px 10px;font-size:12px;color:var(--text)}
.research-footer{display:flex;gap:8px;padding-top:16px;border-top:1px solid var(--border);margin-top:16px}
.research-loading{text-align:center;padding:48px 24px}
.research-loading .spinner{display:inline-block;width:32px;height:32px;border:3px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin 0.8s linear infinite;margin-bottom:12px}
@keyframes spin{to{transform:rotate(360deg)}}
.research-loading p{color:var(--muted);font-size:13px}
.research-loading .elapsed{font-size:11px;color:var(--muted);margin-top:8px}
.research-error{text-align:center;padding:32px;color:var(--red);font-size:13px}
/* ── Pipeline ─────────────────────────────────────────────────────────── */
.daily-action-card{background:linear-gradient(135deg,#0f1a0f 0%,#111 50%,#0d0d0d 100%);border:1px solid rgba(245,200,66,.25);border-radius:12px;padding:20px 22px;margin-bottom:22px}
.daily-action-title{font-size:13px;font-weight:700;color:var(--gold);letter-spacing:.04em;text-transform:uppercase;margin-bottom:14px;display:flex;align-items:center;gap:8px}
.daily-action-items{display:flex;flex-direction:column;gap:10px}
.daily-action-item{display:flex;align-items:flex-start;gap:12px;padding:10px 14px;border-radius:8px;background:#0d0d0d;border:1px solid #1e1e1e}
.daily-action-item.urgency-high{border-left:3px solid #e55353}
.daily-action-item.urgency-medium{border-left:3px solid #f5c842}
.daily-action-item.urgency-low{border-left:3px solid #4ade80}
.daily-action-icon{font-size:18px;line-height:1;flex-shrink:0;margin-top:1px}
.daily-action-text{font-size:13px;color:var(--text);line-height:1.55}
.pipeline-columns{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;min-height:300px}
@media(max-width:900px){.pipeline-columns{grid-template-columns:repeat(2,1fr)}}
@media(max-width:560px){.pipeline-columns{grid-template-columns:1fr}}
.pipeline-col{background:#0d0d0d;border:1px solid #1e1e1e;border-radius:10px;padding:14px}
.pipeline-col-header{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #1e1e1e;display:flex;align-items:center;justify-content:space-between}
.pipeline-col-header.col-interested{color:#f5c842}
.pipeline-col-header.col-applied{color:#60a5fa}
.pipeline-col-header.col-interviewing{color:#818cf8}
.pipeline-col-header.col-rejected{color:#555}
.pipeline-col-count{background:#1a1a1a;border-radius:10px;padding:1px 7px;font-size:10px}
.pipeline-card{background:#111;border:1px solid #222;border-radius:8px;padding:12px 14px;margin-bottom:10px;transition:border-color .15s;cursor:default}
.pipeline-card:hover{border-color:#333}
.pipeline-card-title{font-size:13px;font-weight:600;color:var(--text);margin-bottom:3px;line-height:1.3}
.pipeline-card-co{font-size:12px;color:var(--gold);font-weight:600;margin-bottom:6px}
.pipeline-card-meta{font-size:11px;color:var(--muted);margin-bottom:8px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pipeline-card-actions{display:flex;gap:6px;flex-wrap:wrap}
.pipeline-empty{color:var(--muted);font-size:12px;text-align:center;padding:20px 0;font-style:italic}
.prep-badge{display:inline-flex;align-items:center;gap:3px;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;background:rgba(129,140,248,.15);color:#818cf8;border:1px solid rgba(129,140,248,.3)}
/* ── Interview Prep Modal ─────────────────────────────────────────────── */
.prep-modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1100;display:none;align-items:center;justify-content:center;padding:20px}
.prep-modal-overlay.open{display:flex}
.prep-modal{background:#111;border:1px solid #333;border-radius:14px;width:100%;max-width:680px;max-height:90vh;overflow:hidden;display:flex;flex-direction:column}
.prep-modal-header{padding:18px 22px 14px;border-bottom:1px solid #222;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-shrink:0}
.prep-modal-title{font-size:15px;font-weight:700;color:var(--text)}
.prep-modal-sub{font-size:12px;color:var(--muted);margin-top:3px}
.prep-modal-body{padding:20px 22px;overflow-y:auto;flex:1}
.prep-section{margin-bottom:20px}
.prep-section-label{font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;color:var(--gold);margin-bottom:8px}
.prep-snapshot{background:#0d0d0d;border-left:3px solid var(--gold);padding:10px 14px;border-radius:0 6px 6px 0;font-size:13px;line-height:1.6;color:var(--text)}
.prep-pitch{background:rgba(245,200,66,.06);border:1px solid rgba(245,200,66,.2);padding:12px 16px;border-radius:8px;font-size:13px;font-weight:600;color:var(--gold);line-height:1.5}
.prep-qa-item{margin-bottom:14px;padding:12px 14px;background:#0d0d0d;border-radius:8px}
.prep-q{font-size:13px;font-weight:600;color:var(--text);margin-bottom:6px}
.prep-a{font-size:12px;color:#aaa;line-height:1.55}
.prep-watchout{background:rgba(229,83,83,.08);border:1px solid rgba(229,83,83,.2);padding:10px 14px;border-radius:6px;font-size:13px;color:#e55353;line-height:1.55}
</style>
</head>
<body>

<header>
  <span class="logo">&#x2B21; JobScout.ai</span>
  <div class="hdr-right">
    <span class="hdr-status" id="hdr-status"></span>
    <span class="gmail-badge off" id="gmail-badge">Gmail: ---</span>
    <span class="dot" id="dot"></span>
  </div>
</header>

<div class="stats-bar" id="stats-bar">
  <div class="stat"><div class="stat-label">Jobs Scanned Today</div><div class="stat-val" id="stat-scanned">-</div></div>
  <div class="stat"><div class="stat-label">Matches Found</div><div class="stat-val" id="stat-matches">-</div></div>
  <div class="stat"><div class="stat-label">Top Score</div><div class="stat-val" id="stat-top">-</div></div>
  <div class="stat"><div class="stat-label">Last Run</div><div class="stat-val" id="stat-lastrun" style="font-size:13px">-</div></div>
</div>

<div class="run-bar">
  <button class="btn btn-gold" id="run-btn" onclick="runScout()">&#9654; Run Scout Now</button>
  <span class="run-msg" id="run-msg"></span>
  <span class="run-stage" id="run-stage" style="display:none"></span>
  <span class="quick-link-sep"></span>
  <div class="quick-links">
    <a class="ql-btn" href="https://www.linkedin.com/jobs/" target="_blank" rel="noopener">
      <img src="https://www.google.com/s2/favicons?domain=linkedin.com&sz=32" alt="">LinkedIn
    </a>
    <a class="ql-btn" href="https://www.indeed.com" target="_blank" rel="noopener">
      <img src="https://www.google.com/s2/favicons?domain=indeed.com&sz=32" alt="">Indeed
    </a>
    <a class="ql-btn" href="https://www.glassdoor.com/Job/index.htm" target="_blank" rel="noopener">
      <img src="https://www.google.com/s2/favicons?domain=glassdoor.com&sz=32" alt="">Glassdoor
    </a>
    <a class="ql-btn" href="https://www.repvue.com" target="_blank" rel="noopener">
      <img src="https://www.google.com/s2/favicons?domain=repvue.com&sz=32" alt="">RepVue
    </a>
    <a class="ql-btn" href="https://wellfound.com/jobs" target="_blank" rel="noopener">
      <img src="https://www.google.com/s2/favicons?domain=wellfound.com&sz=32" alt="">Wellfound
    </a>
    <a class="ql-btn" href="https://www.levels.fyi/jobs" target="_blank" rel="noopener">
      <img src="https://www.google.com/s2/favicons?domain=levels.fyi&sz=32" alt="">Levels.fyi
    </a>
    <a class="ql-btn" href="https://www.ziprecruiter.com" target="_blank" rel="noopener">
      <img src="https://www.google.com/s2/favicons?domain=ziprecruiter.com&sz=32" alt="">ZipRecruiter
    </a>
  </div>
  <span class="auto-run-badge" id="auto-run-badge" style="display:none"></span>
</div>

<!-- Outreach modal -->
<div class="modal-overlay" id="outreach-modal" style="display:none" onclick="if(event.target===this)closeOutreach()">
  <div class="modal-box">
    <button class="modal-close" onclick="closeOutreach()">&times;</button>
    <div class="modal-title" id="outreach-title">Reach Out</div>
    <div id="outreach-body">
      <div class="modal-spinner">Drafting your message with Claude&#8230;</div>
    </div>
  </div>
</div>

<!-- Cover Letter Modal -->
<div class="modal-overlay" id="cl-modal" style="display:none" onclick="if(event.target===this)closeCoverLetterModal()">
  <div class="cl-modal-box">
    <div class="cl-modal-header">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="flex:1;min-width:0">
          <div class="cl-modal-title" id="cl-modal-title">Cover Letter</div>
          <div class="cl-modal-sub">
            <span id="cl-modal-ts"></span>
            <span id="cl-model-badge" style="display:none;font-size:11px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:2px 9px"></span>
            <span id="cl-cached-badge" style="display:none;color:var(--gold)">&#x2713; Cached</span>
            <button class="btn btn-ghost btn-sm" id="cl-regen-btn" onclick="regenerateCoverLetter()" style="padding:2px 10px;font-size:11px">&#x21BA; Regenerate</button>
          </div>
        </div>
        <button class="modal-close" style="position:static;margin-top:-4px" onclick="closeCoverLetterModal()">&times;</button>
      </div>
    </div>

    <!-- Loading state -->
    <div id="cl-loading" style="padding:40px 24px;text-align:center">
      <div class="spinner" style="margin:0 auto 14px"></div>
      <div style="font-size:13px;color:var(--muted)" id="cl-loading-msg">Researching company with web search&hellip;</div>
      <div style="font-size:11px;color:var(--muted);margin-top:6px" id="cl-loading-sub">Step 1: gathering specific facts &mdash; Step 2: writing your letter</div>
    </div>

    <!-- Error state -->
    <div id="cl-error" style="display:none;padding:32px 24px;text-align:center">
      <div style="color:#ff6b6b;font-size:13px;margin-bottom:12px" id="cl-error-msg"></div>
      <button class="btn btn-gold btn-sm" onclick="regenerateCoverLetter()">Try Again</button>
    </div>

    <!-- Content -->
    <div class="cl-modal-body" id="cl-content" style="display:none">
      <div class="cl-letter-wrap" id="cl-letter-text"></div>

      <div class="cl-research-section" id="cl-research-section" style="display:none">
        <div class="cl-research-header" onclick="toggleClResearch()">
          <span id="cl-research-toggle">&#x25B6;</span>
          Research Sources
        </div>
        <div class="cl-research-list" id="cl-research-list"></div>
      </div>
    </div>

    <div class="cl-modal-footer" id="cl-footer" style="display:none">
      <button class="btn btn-gold btn-sm" onclick="copyCoverLetter()">&#x1F4CB; Copy to Clipboard</button>
      <button class="btn btn-ghost btn-sm" onclick="downloadCoverLetter()">&#x2B07; Download .txt</button>
    </div>
  </div>
</div>

<div class="app-body">
<nav class="sidebar">
  <div class="nav-group">
    <div class="nav-group-label">Search</div>
    <div class="tab active" id="tab-jobs" onclick="showTab('jobs')" data-tooltip="Your scored job board. Claude rates every listing Top Target / Fast Win / Stretch / Probably Skip against your resume and settings.">Scout</div>
    <div class="tab" id="tab-saved" onclick="showTab('saved')" data-tooltip="Jobs you've starred. Generate tailored resumes and cover letters from each one.">Saved Jobs</div>
    <div class="tab" id="tab-intel" onclick="showTab('intel')" data-tooltip="Gemini scans the web daily for companies actively hiring in your space. Market trends, emerging themes, hot companies to target now.">Career Intel</div>
    <div class="tab" id="tab-pulse" onclick="showTab('pulse')" data-tooltip="Job Market Pulse — which companies are hiring most aggressively, what roles are trending, salary patterns from your scout data, and Gemini's verdict: true growth or hype?">Job Market Pulse</div>
    <div class="tab" id="tab-leaders" onclick="showTab('leaders')" data-tooltip="Claude-ranked top 5-10 sales-led companies per sector — SaaS, Cybersecurity, AI Infrastructure, Networking and more. The gold standard companies to target for your next move.">Industry Leaders</div>
    <div class="tab" id="tab-deepvalue" onclick="showTab('deepvalue')" data-tooltip="Gemini finds the cutting-edge infrastructure companies with the clearest 'why you need this' value prop — AI Infra, HPC, Semiconductors, Photonics, Networking, Data Center and more.">Deep Value</div>
    <div class="tab" id="tab-preipo" onclick="showTab('preipo')" data-tooltip="Explosive pre-IPO companies worth joining NOW. Series B is the sweet spot — proven PMF, scaling sales motion, meaningful equity. Ranked by momentum score using real funding data.">Pre-IPO</div>
    <div class="tab" id="tab-news" onclick="showTab('news')" data-tooltip="Live B2B tech news feed — fresh articles from top sources analyzed by Gemini. See which companies are funding, hiring, or expanding sales teams right now.">Industry News</div>
    <div class="tab" id="tab-clawd" onclick="showTab('clawd')" data-tooltip="Embedded interview and career coaching tool.">DeathByClawd</div>
    <div class="tab" id="tab-email" onclick="showTab('email')" data-tooltip="Weekly Scout Report — sent every Monday morning. Top 10 ranked matches from the past week with a Claude-written briefing. Preview, test send, and manage your Gmail connection here.">Weekly Report</div>
  </div>
  <div class="nav-group">
    <div class="nav-group-label">Execute</div>
    <div class="tab" id="tab-pipeline" onclick="showTab('pipeline')" data-tooltip="Your active application pipeline. Track every job you've applied to, are interviewing for, or are interested in — with daily AI action recommendations.">My Pipeline</div>
    <div class="tab" id="tab-research" onclick="showTab('research')" data-tooltip="Deep-dive company research powered by Claude. Culture, financials, hiring signals, and interview prep before you apply.">Company Research</div>
    <div class="tab" id="tab-positioning" onclick="showTab('positioning')" data-tooltip="Content studio — separate from the job search. Generates your LinkedIn headline, pitches, bios, and objection prep from your intake form. Never affects scoring or discovery.">Positioning</div>
    <div class="tab" id="tab-resume" onclick="showTab('resume')" data-tooltip="Your uploaded resume. The first 2,500 characters go to Claude on every scoring run so it can judge whether you actually qualify — not just keyword match.">Resume</div>
  </div>
  <div class="nav-group">
    <div class="nav-group-label">Settings</div>
    <div class="tab" id="tab-settings" onclick="showTab('settings')" data-tooltip="Controls what the scout actually searches for: target roles, industries, locations, must-have skills, things to avoid, and salary floor. The scout won't run without this configured.">User Search Settings</div>
    <div class="tab" id="tab-companies" onclick="showTab('companies')" data-tooltip="Your Company Watchlist — tracks open roles at each company daily using Gemini search. Also tells the scraper which ATS pages to hit and boosts their score.">Company Watchlist</div>
    <div class="tab" id="tab-runs" onclick="showTab('runs')" data-tooltip="Full log of every scout run — jobs found, matches scored, errors, and timing. Use this to debug why a run found too many or too few results.">Run History</div>
  </div>
</nav>
<div class="main-content">
<div class="panel active" id="panel-jobs">
  <div class="rescore-banner hidden" id="rescore-banner">
    <div>
      <div class="rescore-msg"><strong id="rescore-msg-main">Scoring your library...</strong></div>
      <div class="rescore-progress" id="rescore-progress-msg"></div>
    </div>
    <button class="btn btn-gold btn-sm" id="rescore-btn" onclick="startRescore(false)">Score All Jobs</button>
    <button class="btn btn-ghost btn-sm" id="force-rescore-btn" onclick="if(confirm('Re-score all 127 jobs with descriptions using current criteria and OTE rules? This uses AI credits and takes a few minutes.')){startRescore(true)}" title="Re-score all jobs that have descriptions, even if already scored. Use after criteria changes or description enrichment." style="font-size:11px">↺ Force Rescore</button>
    <button class="btn btn-ghost btn-sm" id="conf-filter-btn" onclick="toggleConfidenceFilter()" title="Hide jobs with broken or unresolved links" style="font-size:11px">\uD83D\uDD17 Show broken links</button>
  </div>
  <div class="jobs-sort-bar">
    <span style="color:#666;font-size:11px;letter-spacing:.03em">Sort:</span>
    <select class="sort-sel" id="sort-mode-select" onchange="setSortMode(this.value)" title="Sort jobs by dimension">
      <option value="score">Overall Score</option>
      <option value="role_fit">Role Fit</option>
      <option value="company">Company Quality</option>
      <option value="source">Source Quality</option>
      <option value="freshness">Freshness</option>
      <option value="urgency">Hiring Urgency</option>
      <option value="upside">Career Upside</option>
    </select>
  </div>
  <div class="inner-tabs">
    <div class="inner-tab tier-target active" id="jtab-target" onclick="showJobsTab('target')">&#x1F3AF; Top Targets <span id="jtab-count-target" style="opacity:.6;font-size:10px;margin-left:4px"></span></div>
    <div class="inner-tab tier-win" id="jtab-win" onclick="showJobsTab('win')">&#x26A1; Fast Wins <span id="jtab-count-win" style="opacity:.6;font-size:10px;margin-left:4px"></span></div>
    <div class="inner-tab tier-stretch" id="jtab-stretch" onclick="showJobsTab('stretch')">&#x1F680; Stretch <span id="jtab-count-stretch" style="opacity:.6;font-size:10px;margin-left:4px"></span></div>
    <div class="inner-tab tier-skip" id="jtab-skip" onclick="showJobsTab('skip')">&#x1F6AB; Probably Skip <span id="jtab-count-skip" style="opacity:.6;font-size:10px;margin-left:4px"></span></div>
    <div class="inner-tab" id="jtab-all" onclick="showJobsTab('all')">All <span id="jtab-count-all" style="opacity:.6;font-size:10px;margin-left:4px"></span></div>
  </div>
  <div class="sec-title" id="jobs-count">Loading jobs&hellip;</div>
  <div class="jobs-grid" id="jobs-grid"></div>
</div>

<div class="panel" id="panel-saved">
  <div class="sec-title" id="saved-count">Loading saved jobs&hellip;</div>
  <div class="jobs-grid" id="saved-grid"></div>
</div>

<div class="panel" id="panel-pipeline">
  <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:18px">
    <div>
      <div class="sec-title" style="margin-bottom:2px">&#x1F4CB; My Pipeline</div>
      <div style="font-size:12px;color:var(--muted)">All tracked applications &mdash; moved through stages with AI coaching</div>
    </div>
    <button class="btn btn-gold btn-sm" onclick="loadDailyActions()" id="actions-refresh-btn">&#x26A1; Refresh Actions</button>
  </div>

  <!-- Daily Action Card -->
  <div class="daily-action-card" id="daily-action-card">
    <div class="daily-action-title">&#x1F9E0; Today&rsquo;s Top 3 Actions</div>
    <div id="daily-action-body" class="daily-action-items">
      <div style="color:var(--muted);font-size:13px;font-style:italic">Click &ldquo;Refresh Actions&rdquo; to generate personalized recommendations from your pipeline.</div>
    </div>
  </div>

  <!-- Kanban columns -->
  <div class="pipeline-columns" id="pipeline-columns">
    <div class="pipeline-col">
      <div class="pipeline-col-header col-interested">&#x2605; Interested <span class="pipeline-col-count" id="pipe-count-interested">0</span></div>
      <div id="pipe-col-interested"></div>
    </div>
    <div class="pipeline-col">
      <div class="pipeline-col-header col-applied">&#x2713; Applied <span class="pipeline-col-count" id="pipe-count-applied">0</span></div>
      <div id="pipe-col-applied"></div>
    </div>
    <div class="pipeline-col">
      <div class="pipeline-col-header col-interviewing">&#x1F4CB; Interviewing <span class="pipeline-col-count" id="pipe-count-interviewing">0</span></div>
      <div id="pipe-col-interviewing"></div>
    </div>
    <div class="pipeline-col">
      <div class="pipeline-col-header col-rejected">&#x2715; Rejected <span class="pipeline-col-count" id="pipe-count-rejected">0</span></div>
      <div id="pipe-col-rejected"></div>
    </div>
  </div>
  <div id="pipeline-empty" style="display:none;text-align:center;padding:48px 24px;color:var(--muted)">
    <div style="font-size:32px;margin-bottom:12px">&#x1F4CB;</div>
    <div style="font-size:15px;font-weight:600;margin-bottom:6px">Your pipeline is empty</div>
    <div style="font-size:13px">Use the Track Status dropdown on any job card to add jobs here.</div>
    <button class="btn btn-gold btn-sm" style="margin-top:16px" onclick="showTab('jobs')">Browse Jobs &rarr;</button>
  </div>
</div>

<!-- Interview Prep Modal -->
<div class="prep-modal-overlay" id="prep-modal-overlay" onclick="if(event.target===this)closePrepModal()">
  <div class="prep-modal">
    <div class="prep-modal-header">
      <div>
        <div class="prep-modal-title" id="prep-modal-title">Interview Prep</div>
        <div class="prep-modal-sub" id="prep-modal-sub"></div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="closePrepModal()" style="flex-shrink:0">&#x2715; Close</button>
    </div>
    <div class="prep-modal-body" id="prep-modal-body">
      <div style="text-align:center;padding:40px;color:var(--muted)">Loading battle card&hellip;</div>
    </div>
  </div>
</div>

<div class="panel" id="panel-research">
  <div class="sec-title" id="research-page-count">Loading saved research&hellip;</div>
  <div class="jobs-grid" id="research-grid"></div>
  <div class="empty" id="research-empty" style="display:none">No saved research briefs yet &mdash; click &ldquo;Research Company&rdquo; on any job card, then save the brief.</div>
</div>

<div class="panel" id="panel-resume">
  <!-- Toolbar: saved resumes picker + upload -->
  <div class="resume-toolbar">
    <div class="resume-dropdown-wrap" id="resume-dd-wrap">
      <button class="btn btn-ghost btn-sm" onclick="toggleResumeDropdown()" id="resume-dd-btn">Saved Resumes ▾</button>
      <div class="resume-dropdown" id="resume-dropdown" style="display:none">
        <div id="resume-dd-list"><div class="resume-dropdown-empty">No saved resumes yet.</div></div>
        <div style="border-top:1px solid var(--border);padding:10px 14px">
          <div class="save-name-row">
            <input type="text" id="resume-save-name" placeholder="Name this resume…" style="flex:1;padding:6px 10px;font-size:12px;border-radius:6px;border:1px solid var(--border);background:var(--bg);color:var(--text)">
            <button class="btn btn-gold btn-sm" onclick="saveNamedResume()">Save Current</button>
          </div>
        </div>
      </div>
    </div>
    <label class="upload-zone" style="cursor:pointer">
      <span>📎 Upload PDF or Word doc</span>
      <input type="file" accept=".pdf,.docx" style="display:none" onchange="uploadResumeFile(this)">
    </label>
    <span id="upload-msg" style="font-size:12px;color:var(--muted)"></span>
    <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
      <span style="font-size:11px;color:var(--muted)">Target length:</span>
      <div class="page-toggle" id="page-toggle">
        <button class="page-toggle-btn active" data-pages="1" onclick="setPageTarget(1)">1 Page</button>
        <button class="page-toggle-btn" data-pages="2" onclick="setPageTarget(2)">2 Pages</button>
      </div>
    </div>
  </div>

  <div class="resume-split">
    <div class="resume-col">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <div class="sec-title">Base Resume <span id="active-resume-label" style="color:var(--gold);font-weight:400;font-size:11px"></span></div>
      </div>
      <textarea id="resume-text" rows="20" placeholder="Paste your full resume here, or upload a PDF/Word file above…"></textarea>
      <div class="save-row">
        <button class="btn btn-gold btn-sm" onclick="saveResume()">Save as Active</button>
        <span class="ok-msg" id="resume-msg" style="display:none">Saved!</span>
      </div>
    </div>
    <div class="resume-col">
      <div class="sec-title" style="margin-bottom:8px">Job Description</div>
      <textarea id="job-desc-text" rows="20" placeholder="Paste the job listing description here…"></textarea>
      <div class="save-row">
        <button class="btn btn-gold" onclick="tailorFromDesc()">Tailor Resume and Write CV</button>
        <span id="tailor-inline-msg" style="font-size:12px;color:var(--muted)"></span>
      </div>
    </div>
  </div>

  <div id="tailor-result" style="display:none;margin-top:24px">
    <div id="tailor-analysis-inline" style="display:none" class="tailor-analysis"></div>
    <div class="resume-split">
      <div class="resume-col">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div class="sec-title">Tailored Resume</div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm" onclick="copyRendered('tailor-result-resume')">Copy</button>
            <button class="btn btn-ghost btn-sm" onclick="downloadDocx('tailor-result-resume','Tailored_Resume')">⬇ Word</button>
            <button class="btn btn-ghost btn-sm" onclick="printResume('tailor-result-resume')">⬇ PDF</button>
          </div>
        </div>
        <div class="resume-rendered" id="tailor-result-resume"></div>
      </div>
      <div class="resume-col">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
          <div class="sec-title">Cover Letter</div>
          <div style="display:flex;gap:6px">
            <button class="btn btn-ghost btn-sm" onclick="copyRendered('tailor-result-cover')">Copy</button>
            <button class="btn btn-ghost btn-sm" onclick="downloadDocx('tailor-result-cover','Cover_Letter')">⬇ Word</button>
            <button class="btn btn-ghost btn-sm" onclick="printResume('tailor-result-cover')">⬇ PDF</button>
          </div>
        </div>
        <div class="resume-rendered" id="tailor-result-cover"></div>
      </div>
    </div>
    <details style="margin-top:16px;border:1px solid var(--border);border-radius:8px;padding:0 12px">
      <summary style="cursor:pointer;font-size:13px;color:var(--gold);font-weight:600;padding:12px 0;user-select:none">▸ What Changed & Why</summary>
      <div style="padding-bottom:14px">
        <div class="resume-rendered" id="tailor-result-edits"></div>
      </div>
    </details>
  </div>
</div>

<div class="panel" id="panel-email">
  <div class="email-section">
    <!-- Header -->
    <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:16px;margin-bottom:20px">
      <div>
        <div class="sec-title" style="margin-bottom:4px">Weekly Scout Report</div>
        <div style="font-size:12px;color:var(--muted)">Sent every Monday morning &mdash; top 10 matches ranked by score with a Claude-written briefing</div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="btn btn-gold btn-sm" id="gmail-connect-btn" onclick="connectGmail()">Connect Gmail</button>
        <button class="btn btn-red btn-sm" id="gmail-disconnect-btn" onclick="disconnectGmail()" style="display:none">Disconnect Gmail</button>
      </div>
    </div>

    <!-- Status bar -->
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:20px;display:flex;flex-wrap:wrap;gap:16px;align-items:center">
      <div>
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Gmail Status</div>
        <span id="gmail-status-text" style="font-size:13px;font-weight:600;color:var(--muted)">Checking&hellip;</span>
      </div>
      <div>
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Send Time (Mondays)</div>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="time" id="digest-time" value="07:00" style="width:110px;padding:4px 8px;font-size:12px;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:5px">
          <button class="btn btn-ghost btn-sm" onclick="saveDigestTime()">Save</button>
          <span class="ok-msg" id="digest-time-msg" style="display:none">Saved!</span>
        </div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Next Send</div>
        <div id="email-next-send" style="font-size:13px;color:var(--text)">Loading&hellip;</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:2px">Last Sent</div>
        <div id="email-last-sent" style="font-size:13px;color:var(--text)">&mdash;</div>
      </div>
      <div style="margin-left:auto;display:flex;align-items:center;gap:8px">
        <button class="btn btn-gold btn-sm" onclick="sendTestDigest()">Send Test Now</button>
        <span id="test-email-msg" style="font-size:11px;color:var(--muted)"></span>
      </div>
    </div>

    <!-- Preview -->
    <div style="font-size:13px;font-weight:700;color:var(--text);margin-bottom:8px">Email Preview <span style="font-size:11px;font-weight:400;color:var(--muted)">&mdash; top 10 matches from the past 7 days</span></div>
    <div class="email-preview" id="email-preview">Loading preview&hellip;</div>
  </div>
</div>

<div class="panel" id="panel-runs">
  <table class="tbl">
    <thead><tr>
      <th>#</th><th>Status</th><th>Companies</th><th>Jobs Found</th><th>Matches</th><th>Started</th><th>Completed</th><th>Error</th>
    </tr></thead>
    <tbody id="runs-body"></tbody>
  </table>
  <div class="empty" id="runs-empty" style="display:none">No scout runs yet.</div>
</div>

<div class="panel" id="panel-intel">
  <div class="intel-header">
    <div>
      <div class="sec-title" style="margin-bottom:4px">Career Intel</div>
      <div class="intel-meta" id="intel-meta">Powered by Gemini + Google Search grounding &mdash; refreshes daily</div>
    </div>
    <button class="btn btn-gold btn-sm" id="intel-refresh-btn" onclick="refreshCareerIntel()">Refresh Intel</button>
  </div>

  <!-- Preference Profile Section (always visible) -->
  <div id="pref-profile-section" style="background:#111;border:1px solid #222;border-radius:10px;padding:18px 20px;margin-bottom:20px">
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
      <div>
        <div style="font-size:14px;font-weight:700;color:var(--text)">&#x1F9E0; Behavioral Preference Profile</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">Claude analyzes your tracked job actions to reveal revealed preferences &mdash; not what you say, but what you actually respond to</div>
      </div>
      <button class="btn btn-ghost btn-sm" id="pref-analyze-btn" onclick="loadPreferenceProfile()">Analyze My Preferences</button>
    </div>
    <div id="pref-loading" style="display:none;color:var(--muted);font-size:13px;padding:8px 0">Analyzing your job activity&hellip;</div>
    <div id="pref-output"></div>
  </div>

  <div id="intel-loading" style="display:none">
    <div class="intel-loading-wrap">
      <div class="intel-spinner"></div>
      <div class="intel-loading-msg">Gemini is searching and synthesising company signals&hellip;<br><span style="font-size:11px;color:var(--muted)">This typically takes 30&ndash;60 seconds</span></div>
    </div>
  </div>

  <div id="intel-empty" style="display:none">
    <div class="empty">No Career Intel generated yet. Click &ldquo;Refresh Intel&rdquo; to generate your personalised company opportunity radar.</div>
  </div>

  <div id="intel-error" style="display:none" class="intel-error-box"></div>

  <div id="intel-content" style="display:none">
    <div class="intel-market-summary" id="intel-market-summary"></div>

    <div id="intel-themes-section" style="display:none">
      <div class="intel-section-label">Emerging Themes</div>
      <div class="intel-themes-grid" id="intel-themes"></div>
    </div>

    <div class="intel-section-label" id="intel-companies-label">Company Opportunity Radar</div>
    <div class="intel-cards" id="intel-cards"></div>

    <div class="intel-footer" id="intel-footer"></div>

    <!-- Cross-page: Sync signals to Positioning -->
    <div style="margin-top:16px;padding:14px 16px;background:#0d1a0d;border:1px solid rgba(74,222,128,.15);border-radius:8px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div>
        <div style="font-size:13px;font-weight:600;color:#4ade80">&#x1F9E9; Sync to Positioning</div>
        <div style="font-size:12px;color:var(--muted);margin-top:2px">Use these market signals to sharpen your LinkedIn headline, pitch, and narrative</div>
      </div>
      <button class="btn btn-sm" style="background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.3)" onclick="showTab('positioning')">Go to Positioning &rarr;</button>
    </div>

    <div id="intel-scan-section" style="margin-top:24px;border-top:1px solid var(--border);padding-top:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text)">Open Roles at These Companies</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">Search for matching jobs at every company in this radar</div>
        </div>
        <button class="btn btn-gold" id="intel-scan-btn" onclick="scanForRoles('intel')">&#x1F50D; Find Open Roles</button>
      </div>
      <div id="intel-scan-spinner" style="display:none;text-align:center;padding:20px 0">
        <div class="intel-spinner" style="margin:0 auto 10px"></div>
        <div style="font-size:12px;color:var(--muted)">Asking Gemini to search for open roles at each company&hellip; (30-90s)</div>
      </div>
      <div id="intel-scan-error" style="display:none;color:#ff6b6b;font-size:13px;margin-top:10px"></div>
      <div id="intel-scan-results" style="display:none;margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none" onclick="toggleIntelScanResults()">
          <div id="intel-scan-count" style="font-size:13px;font-weight:700;color:var(--gold)"></div>
          <span id="intel-scan-toggle" style="font-size:12px;color:var(--muted)">&#x25B2; Collapse</span>
        </div>
        <div id="intel-scan-jobs" style="margin-top:12px"></div>
      </div>
    </div>
  </div>
</div>

<div class="panel" id="panel-pulse">
  <div class="pulse-header">
    <div>
      <div class="sec-title" style="margin-bottom:4px">Job Market Pulse</div>
      <div class="intel-meta" id="pulse-meta">Scout data + Gemini search &mdash; hiring trends and signal analysis for your target companies</div>
    </div>
    <button class="btn btn-gold btn-sm" id="pulse-refresh-btn" onclick="refreshJobMarketPulse()">&#x26A1; Refresh Pulse</button>
  </div>

  <div id="pulse-loading" style="display:none">
    <div class="intel-loading-wrap">
      <div class="intel-spinner"></div>
      <div class="intel-loading-msg">Gemini is analyzing hiring signals across your target companies&hellip;<br><span style="font-size:11px;color:var(--muted)">Assessing growth vs hype for each company &mdash; 30&ndash;90 seconds</span></div>
    </div>
  </div>

  <div id="pulse-empty" style="display:none">
    <div class="empty">No pulse data yet. Run your job scout first to collect company data, then click &ldquo;Refresh Pulse&rdquo; to generate the analysis.</div>
  </div>

  <div id="pulse-error" style="display:none;color:var(--red);background:#ff000011;border:1px solid #ff000033;border-radius:8px;padding:12px 14px;font-size:13px;margin-bottom:16px"></div>

  <div id="pulse-content" style="display:none">

    <!-- Market mood banner -->
    <div id="pulse-mood-banner" style="border-radius:10px;padding:16px 20px;margin-bottom:20px;display:flex;align-items:flex-start;gap:14px">
      <div id="pulse-mood-icon" style="font-size:28px;line-height:1;flex-shrink:0"></div>
      <div>
        <div id="pulse-headline" style="font-size:15px;font-weight:700;color:var(--text);margin-bottom:6px"></div>
        <div id="pulse-commentary" style="font-size:13px;color:var(--muted);line-height:1.7"></div>
      </div>
    </div>

    <!-- Scout stats bar -->
    <div id="pulse-stats-bar" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:20px"></div>

    <!-- Signal legend -->
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px;align-items:center">
      <span style="font-size:11px;color:var(--muted);margin-right:4px;font-weight:600;text-transform:uppercase;letter-spacing:.06em">Signal:</span>
      <span class="pulse-sig-chip pulse-sig-true_growth">True Growth</span>
      <span class="pulse-sig-chip pulse-sig-cautious">Cautious</span>
      <span class="pulse-sig-chip pulse-sig-hype_risk">Hype Risk</span>
      <span class="pulse-sig-chip pulse-sig-desperate_hiring">Desperate Hiring</span>
      <span class="pulse-sig-chip pulse-sig-ai_risk">AI Risk</span>
      <span class="pulse-sig-chip pulse-sig-unknown">Unverified</span>
    </div>

    <!-- Company cards -->
    <div class="intel-section-label">Company Signal Cards</div>
    <div id="pulse-cards" class="pulse-cards-grid"></div>

    <div id="pulse-footer" style="margin-top:16px;font-size:11px;color:var(--muted);text-align:right"></div>
  </div>
</div>

<div class="panel" id="panel-deepvalue">
  <div class="dv-header">
    <div>
      <div class="sec-title" style="margin-bottom:4px">Deep Value</div>
      <div class="dv-meta" id="dv-meta">Gemini finds cutting-edge infrastructure companies with the clearest customer value prop &mdash; plus open roles</div>
    </div>
    <button class="btn btn-gold btn-sm" id="dv-refresh-btn" onclick="refreshDeepValue()">Refresh Intel</button>
  </div>

  <div id="dv-loading" style="display:none">
    <div class="dv-loading-wrap">
      <div class="dv-spinner"></div>
      <div class="dv-loading-msg">Gemini is searching for the most compelling infrastructure companies with undeniable value props&hellip;<br><span style="font-size:11px;color:var(--muted)">Typically takes 30&ndash;60 seconds</span></div>
    </div>
  </div>

  <div id="dv-empty" style="display:none">
    <div class="dv-empty">No Deep Value data yet.<br>Click &ldquo;Refresh Intel&rdquo; to have Gemini search for cutting-edge infrastructure companies with the clearest &ldquo;why you need this&rdquo; value props &mdash; plus any open roles at each.</div>
  </div>

  <div id="dv-error" style="display:none" class="dv-error-box"></div>

  <div id="dv-content" style="display:none">
    <div class="dv-summary" id="dv-summary"></div>
    <div class="dv-grid" id="dv-grid"></div>
    <div class="dv-footer" id="dv-footer"></div>
  </div>
</div>

<div class="panel" id="panel-preipo">
  <div class="preipo-header">
    <div>
      <div class="sec-title" style="margin-bottom:4px">Pre-IPO Opportunity Radar</div>
      <div class="preipo-meta" id="preipo-meta">Powered by Gemini + Google Search &mdash; identifies hypergrowth companies by funding stage</div>
    </div>
    <button class="btn btn-gold btn-sm" id="preipo-refresh-btn" onclick="refreshPreIpo()">Refresh Radar</button>
  </div>

  <div id="preipo-loading" style="display:none">
    <div class="preipo-loading-wrap">
      <div class="preipo-spinner"></div>
      <div class="preipo-loading-msg">Gemini is scanning funding data, growth signals, and hiring intelligence&hellip;<br><span style="font-size:11px;color:var(--muted)">Typically takes 30&ndash;90 seconds</span></div>
    </div>
  </div>

  <div id="preipo-empty" style="display:none">
    <div class="preipo-empty">No Pre-IPO data yet.<br>Click &ldquo;Refresh Radar&rdquo; to scan for explosive growth companies worth joining now.</div>
  </div>

  <div id="preipo-error" style="display:none" class="preipo-error-box"></div>

  <div id="preipo-content" style="display:none">
    <div class="preipo-thesis-box" id="preipo-thesis-box">
      <div class="preipo-thesis-icon">&#x26A1;</div>
      <div>
        <div class="preipo-thesis-title">Why Series B is the Sales Sweet Spot Right Now</div>
        <div class="preipo-thesis-text" id="preipo-thesis-text"></div>
      </div>
    </div>

    <div class="preipo-market-ctx" id="preipo-market-ctx"></div>

    <div class="preipo-stage-filters" id="preipo-stage-filters">
      <button class="preipo-stage-btn active" data-stage="all" onclick="filterPreIpo('all')">All</button>
      <button class="preipo-stage-btn" data-stage="Series A" onclick="filterPreIpo('Series A')">Series A</button>
      <button class="preipo-stage-btn seriesb" data-stage="Series B" onclick="filterPreIpo('Series B')">&#x2B50; Series B &mdash; Hypergrowth</button>
      <button class="preipo-stage-btn" data-stage="Series C" onclick="filterPreIpo('Series C')">Series C</button>
      <button class="preipo-stage-btn" data-stage="Series D+" onclick="filterPreIpo('Series D+')">Series D+</button>
    </div>

    <div class="preipo-grid" id="preipo-grid"></div>

    <div class="preipo-footer" id="preipo-footer"></div>

    <div id="preipo-scan-section" style="margin-top:24px;border-top:1px solid var(--border);padding-top:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text)">Open Roles at These Companies</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">Search for matching jobs at every company in this radar</div>
        </div>
        <button class="btn btn-gold" id="preipo-scan-btn" onclick="scanForRoles('preipo')">&#x1F50D; Find Open Roles</button>
      </div>
      <div id="preipo-scan-spinner" style="display:none;text-align:center;padding:20px 0">
        <div class="intel-spinner" style="margin:0 auto 10px"></div>
        <div style="font-size:12px;color:var(--muted)">Asking Gemini to search for open roles at each company&hellip; (30-90s)</div>
      </div>
      <div id="preipo-scan-error" style="display:none;color:#ff6b6b;font-size:13px;margin-top:10px"></div>
      <div id="preipo-scan-results" style="display:none;margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none" onclick="togglePreIpoScanResults()">
          <div id="preipo-scan-count" style="font-size:13px;font-weight:700;color:var(--gold)"></div>
          <span id="preipo-scan-toggle" style="font-size:12px;color:var(--muted)">&#x25B2; Collapse</span>
        </div>
        <div id="preipo-scan-jobs" style="margin-top:12px"></div>
      </div>
    </div>
  </div>
</div>

<div class="panel" id="panel-leaders">
  <div class="leaders-header">
    <div>
      <div class="sec-title" style="margin-bottom:4px">Industry Leaders</div>
      <div class="leaders-meta" id="leaders-meta">Claude-ranked top sales-led companies per sector &mdash; refreshes weekly</div>
    </div>
    <button class="btn btn-gold btn-sm" id="leaders-refresh-btn" onclick="refreshIndustryLeaders()">Refresh Leaders</button>
  </div>

  <div id="leaders-loading" style="display:none">
    <div class="leaders-loading-wrap">
      <div class="leaders-spinner"></div>
      <div class="leaders-loading-msg">Claude is analysing market signals and ranking the top sales-led companies&hellip;<br><span style="font-size:11px;color:var(--muted)">Typically takes 20&ndash;40 seconds</span></div>
    </div>
  </div>

  <div id="leaders-empty" style="display:none">
    <div class="leaders-empty">No Industry Leaders data yet.<br>Click &ldquo;Refresh Leaders&rdquo; to generate Claude&rsquo;s ranked list of the top sales-led companies in every major sector.</div>
  </div>

  <div id="leaders-error" style="display:none" class="leaders-error-box"></div>

  <div id="leaders-content" style="display:none">
    <div class="leaders-overview" id="leaders-overview"></div>
    <div id="leaders-sectors"></div>
    <div class="leaders-footer" id="leaders-footer"></div>

    <div id="leaders-scan-section" style="margin-top:24px;border-top:1px solid var(--border);padding-top:20px">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:8px">
        <div>
          <div style="font-size:14px;font-weight:700;color:var(--text)">Open Roles at These Companies</div>
          <div style="font-size:12px;color:var(--muted);margin-top:2px">Search for matching jobs at every company in this radar</div>
        </div>
        <button class="btn btn-gold" id="leaders-scan-btn" onclick="scanForRoles('leaders')">&#x1F50D; Find Open Roles</button>
      </div>
      <div id="leaders-scan-spinner" style="display:none;text-align:center;padding:20px 0">
        <div class="intel-spinner" style="margin:0 auto 10px"></div>
        <div style="font-size:12px;color:var(--muted)">Asking Gemini to search for open roles at each company&hellip; (30-90s)</div>
      </div>
      <div id="leaders-scan-error" style="display:none;color:#ff6b6b;font-size:13px;margin-top:10px"></div>
      <div id="leaders-scan-results" style="display:none;margin-top:14px">
        <div style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;user-select:none" onclick="toggleLeadersScanResults()">
          <div id="leaders-scan-count" style="font-size:13px;font-weight:700;color:var(--gold)"></div>
          <span id="leaders-scan-toggle" style="font-size:12px;color:var(--muted)">&#x25B2; Collapse</span>
        </div>
        <div id="leaders-scan-jobs" style="margin-top:12px"></div>
      </div>
    </div>
  </div>
</div>

<div class="panel" id="panel-companies">
  <div style="margin-bottom:20px">
    <div class="sec-title" style="margin-bottom:4px">Company Watchlist</div>
    <div style="font-size:12px;color:var(--muted)">Gemini searches for open sales roles at each company daily. Green = matching roles found. Also boosts each company&rsquo;s score in your job board.</div>
  </div>

  <!-- Watchlist scan controls -->
  <div class="cw-scan-header">
    <div>
      <div style="font-size:13px;font-weight:700;color:var(--text)">Daily Job Scan</div>
      <div style="font-size:11px;color:var(--muted);margin-top:2px" id="cw-scan-status">Gemini checks for open roles at each company daily &mdash; automatically</div>
    </div>
    <button class="btn btn-ghost btn-sm" id="cw-scan-btn" onclick="runWatchlistScan()">&#x1F50D; Scan Now</button>
  </div>

  <div id="company-list" class="cw-cards-grid"></div>
  <div class="sec-title" style="margin-bottom:12px;margin-top:8px">Add Company</div>
  <div style="font-size:12px;color:var(--muted);margin-bottom:14px">Type a company name — AI will automatically detect the job board and verify it&rsquo;s working.</div>
  <div class="add-form" style="align-items:flex-end">
    <div class="fg" style="flex:2">
      <label>Company Name</label>
      <input type="text" id="co-name" placeholder="e.g. Salesforce, HubSpot, Oracle" onkeydown="if(event.key==='Enter')addCompanyAuto()">
    </div>
    <div class="fg" style="flex:1">
      <label>Website <span class="hint">(optional — helps detection)</span></label>
      <input type="text" id="co-website" placeholder="e.g. salesforce.com" onkeydown="if(event.key==='Enter')addCompanyAuto()">
    </div>
  </div>
  <div style="margin-top:12px;display:flex;align-items:center;gap:12px">
    <button class="btn btn-gold" id="co-add-btn" onclick="addCompanyAuto()">Add Company</button>
    <span id="co-detect-status" style="font-size:12px;color:var(--muted)"></span>
  </div>
</div>
<div class="panel" id="panel-settings">
  <div class="sec-title" style="margin-bottom:16px">Search Criteria</div>
  <div class="settings-grid">
    <div class="fg">
      <label>Minimum Base Pay <span class="hint">Hard gate — jobs below this base are skipped</span></label>
      <div class="input-prefix"><span>$</span><input type="number" id="set-salary" placeholder="150000" step="5000"></div>
    </div>
    <div class="fg">
      <label>Minimum OTE <span class="hint">On-Target Earnings (base + commission at quota)</span></label>
      <div class="input-prefix"><span>$</span><input type="number" id="set-ote" placeholder="350000" step="10000"></div>
    </div>
    <div class="fg full" style="padding:14px 16px;background:#141414;border:1px solid var(--border);border-radius:8px">
      <label style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:10px;display:block">Work Modes <span class="hint">(select all that apply)</span></label>
      <div style="display:flex;gap:20px;flex-wrap:wrap">
        <label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer">
          <input type="checkbox" id="mode-remote-us" style="margin-top:2px;accent-color:var(--gold);flex-shrink:0">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Remote-US</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Work from anywhere in the US — no city attached</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer">
          <input type="checkbox" id="mode-territory" style="margin-top:2px;accent-color:var(--gold);flex-shrink:0">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Remote-in-territory</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Remote but must live near a specific city (enter territory cities in Locations below)</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer">
          <input type="checkbox" id="mode-onsite" style="margin-top:2px;accent-color:var(--gold);flex-shrink:0">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">On-site</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Physical office jobs — only shown if city matches your locations</div>
          </div>
        </label>
      </div>
    </div>
    <div class="fg full">
      <label>Locations <span class="hint">(press Enter to add)</span></label>
      <input type="text" id="set-loc-input" placeholder="e.g. Atlanta GA, Charlotte NC, Nashville TN">
      <div class="tag-list" id="set-loc-tags"></div>
    </div>
    <div class="fg full">
      <label>Target Roles <span class="hint">(press Enter to add)</span></label>
      <input type="text" id="set-roles-input" placeholder="e.g. Account Executive, Account Manager">
      <div class="tag-list" id="set-roles-tags"></div>
    </div>
    <div class="fg full">
      <label>Industries <span class="hint">(press Enter to add)</span></label>
      <input type="text" id="set-ind-input" placeholder="e.g. AI Infrastructure, Semiconductors">
      <div class="tag-list" id="set-ind-tags"></div>
    </div>
    <div class="fg full">
      <label>Must-Have Keywords <span class="hint">(press Enter to add)</span></label>
      <input type="text" id="set-must-input" placeholder="e.g. enterprise sales, quota carrying">
      <div class="tag-list" id="set-must-tags"></div>
    </div>
    <div class="fg full">
      <label>Nice-to-Have Keywords <span class="hint">(press Enter to add)</span></label>
      <input type="text" id="set-nice-input" placeholder="e.g. AI, data center, GPU">
      <div class="tag-list" id="set-nice-tags"></div>
    </div>
    <div class="fg full">
      <label>Avoid Keywords <span class="hint">(press Enter to add)</span></label>
      <input type="text" id="set-avoid-input" placeholder="e.g. SDR, BDR, inbound only">
      <div class="tag-list" id="set-avoid-tags"></div>
    </div>
    <div class="fg">
      <label>Your Name</label>
      <input type="text" id="set-name" placeholder="Your full name">
    </div>
    <div class="fg">
      <label>Your Email</label>
      <input type="email" id="set-email" placeholder="you@example.com">
    </div>
    <div class="fg full">
      <label>Proxy URL <span class="hint" style="color:#f59e0b">— Required to unlock Glassdoor &amp; ZipRecruiter (both Cloudflare-blocked without a proxy)</span></label>
      <input type="text" id="set-proxy-url" placeholder="http://user:pass@host:port  (residential or datacenter proxy)">
      <div style="font-size:11px;color:var(--muted);margin-top:5px;line-height:1.5">
        Without a proxy: <strong style="color:#4ade80">LinkedIn</strong> + <strong style="color:#60a5fa">Indeed</strong> (~1,200+ jobs/run) &nbsp;|&nbsp;
        With a proxy: + <strong style="color:#34d399">Glassdoor</strong> + <strong style="color:#818cf8">ZipRecruiter</strong> (~1,600+ jobs/run).<br>
        Comma-separate multiple proxies for rotation: <code style="background:#111;padding:1px 4px;border-radius:3px">http://u:p@h1:p1,http://u:p@h2:p2</code>
      </div>
    </div>
  </div>

  <div class="sec-title" style="margin:24px 0 16px">Tier Scoring Engine</div>
  <div style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.6">These settings control how jobs are classified into tiers. Adjust thresholds and lists to tune what shows up as Top Target vs Fast Win vs Stretch.</div>

  <div class="settings-grid">
    <div class="fg full" style="padding:14px 16px;background:#141414;border:1px solid var(--border);border-radius:8px">
      <label style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:4px;display:block">Experience Level <span class="hint">(check all levels you want to target — affects what counts as "above level")</span></label>
      <div style="font-size:11px;color:var(--muted);margin-bottom:10px">Jobs at levels above your highest checked level will be classified as Stretch. Select multiple to broaden your search.</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:4px">
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="exp-junior" class="exp-level-cb" style="margin-top:3px;accent-color:var(--gold);flex-shrink:0">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Junior</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">SMB, commercial at a mid-tier company</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="exp-mid" class="exp-level-cb" style="margin-top:3px;accent-color:var(--gold);flex-shrink:0">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Mid</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Commercial at good-fit company, Corporate, MM</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="exp-senior" class="exp-level-cb" style="margin-top:3px;accent-color:var(--gold);flex-shrink:0">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Senior</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Sr./Senior, Named, Enterprise</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer">
          <input type="checkbox" id="exp-strategic" class="exp-level-cb" style="margin-top:3px;accent-color:var(--gold);flex-shrink:0">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Strategic</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Strategic, Sr. Enterprise, Account Director, Major, Majors</div>
          </div>
        </label>
      </div>
    </div>
    <div class="fg" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;align-items:end">
      <div>
        <label style="font-size:11px;color:var(--muted)">Top Target Score</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="range" id="set-top-score" min="50" max="90" step="5" style="flex:1;accent-color:var(--gold)" oninput="document.getElementById('set-top-score-val').textContent=this.value">
          <span id="set-top-score-val" style="font-size:13px;font-weight:700;color:var(--gold);min-width:24px">65</span>
        </div>
      </div>
      <div>
        <label style="font-size:11px;color:var(--muted)">Fast Win Score</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="range" id="set-fast-score" min="40" max="80" step="5" style="flex:1;accent-color:#4ade80" oninput="document.getElementById('set-fast-score-val').textContent=this.value">
          <span id="set-fast-score-val" style="font-size:13px;font-weight:700;color:#4ade80;min-width:24px">55</span>
        </div>
      </div>
      <div>
        <label style="font-size:11px;color:var(--muted)">Stretch Score</label>
        <div style="display:flex;align-items:center;gap:6px">
          <input type="range" id="set-stretch-score" min="40" max="80" step="5" style="flex:1;accent-color:#a78bfa" oninput="document.getElementById('set-stretch-score-val').textContent=this.value">
          <span id="set-stretch-score-val" style="font-size:13px;font-weight:700;color:#a78bfa;min-width:24px">55</span>
        </div>
      </div>
    </div>
    <div class="fg full">
      <label>Vertical Niche Keywords <span class="hint">(industry segments in your background — used to improve scoring context, does NOT affect tier classification)</span></label>
      <input type="text" id="set-niches-input" placeholder="e.g. federal, SLED, healthcare, FSI">
      <div class="tag-list" id="set-niches-tags"></div>
    </div>
  </div>

  <div class="sec-title" style="margin:24px 0 16px">Company Size &amp; Stage</div>
  <div style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.6">Set the type and size of company you want to join. These preferences inform how jobs are ranked and researched — leave everything checked to stay open to all.</div>
  <div class="settings-grid">
    <div class="fg full" style="padding:14px 16px;background:#141414;border:1px solid var(--border);border-radius:8px">
      <label style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:12px;display:block">Company Type <span class="hint">(select all that apply)</span></label>
      <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:flex-start">
        <label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer">
          <input type="checkbox" id="co-type-public" style="margin-top:2px;accent-color:var(--gold);flex-shrink:0">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Public</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Publicly traded — NYSE, NASDAQ, etc.</div>
          </div>
        </label>
        <label style="display:flex;align-items:flex-start;gap:9px;cursor:pointer">
          <input type="checkbox" id="co-type-private" style="margin-top:2px;accent-color:var(--gold);flex-shrink:0" onchange="toggleFundingStages()">
          <div>
            <div style="font-size:13px;font-weight:600;color:var(--text)">Private</div>
            <div style="font-size:11px;color:var(--muted);margin-top:2px">Privately held — startups, PE-backed, etc.</div>
          </div>
        </label>
      </div>
      <div id="funding-stage-row" style="display:none;margin-top:14px;padding-top:14px;border-top:1px solid var(--border)">
        <div style="font-size:12px;font-weight:600;color:var(--muted);margin-bottom:8px;letter-spacing:.05em;text-transform:uppercase">Pre-IPO Funding Stage</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="co-chip"><input type="checkbox" id="fs-series-a" class="co-chip-cb"><span>Series A</span></label>
          <label class="co-chip"><input type="checkbox" id="fs-series-b" class="co-chip-cb"><span>Series B</span></label>
          <label class="co-chip"><input type="checkbox" id="fs-series-c" class="co-chip-cb"><span>Series C</span></label>
          <label class="co-chip"><input type="checkbox" id="fs-series-d" class="co-chip-cb"><span>Series D+</span></label>
          <label class="co-chip"><input type="checkbox" id="fs-bootstrapped" class="co-chip-cb"><span>Bootstrapped</span></label>
          <label class="co-chip"><input type="checkbox" id="fs-pe-backed" class="co-chip-cb"><span>PE-Backed</span></label>
        </div>
      </div>
    </div>
    <div class="fg full" style="padding:14px 16px;background:#141414;border:1px solid var(--border);border-radius:8px">
      <label style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;display:block">Revenue Size <span class="hint">(select all you'd consider)</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="co-chip"><input type="checkbox" id="rev-0-25m" class="co-chip-cb"><span>$0–25M</span></label>
        <label class="co-chip"><input type="checkbox" id="rev-25-50m" class="co-chip-cb"><span>$25–50M</span></label>
        <label class="co-chip"><input type="checkbox" id="rev-50-100m" class="co-chip-cb"><span>$50–100M</span></label>
        <label class="co-chip"><input type="checkbox" id="rev-100-500m" class="co-chip-cb"><span>$100–500M</span></label>
        <label class="co-chip"><input type="checkbox" id="rev-500m-1b" class="co-chip-cb"><span>$500M–1B</span></label>
        <label class="co-chip"><input type="checkbox" id="rev-1b-10b" class="co-chip-cb"><span>$1B–10B</span></label>
        <label class="co-chip"><input type="checkbox" id="rev-10b-plus" class="co-chip-cb"><span>$10B+</span></label>
      </div>
    </div>
    <div class="fg full" style="padding:14px 16px;background:#141414;border:1px solid var(--border);border-radius:8px">
      <label style="font-size:13px;font-weight:600;color:var(--text);margin-bottom:8px;display:block">Employee Count <span class="hint">(select all you'd consider)</span></label>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <label class="co-chip"><input type="checkbox" id="emp-1-10" class="co-chip-cb"><span>1–10</span></label>
        <label class="co-chip"><input type="checkbox" id="emp-10-100" class="co-chip-cb"><span>10–100</span></label>
        <label class="co-chip"><input type="checkbox" id="emp-100-500" class="co-chip-cb"><span>100–500</span></label>
        <label class="co-chip"><input type="checkbox" id="emp-500-1k" class="co-chip-cb"><span>500–1K</span></label>
        <label class="co-chip"><input type="checkbox" id="emp-1k-10k" class="co-chip-cb"><span>1K–10K</span></label>
        <label class="co-chip"><input type="checkbox" id="emp-10k-plus" class="co-chip-cb"><span>10K+</span></label>
      </div>
    </div>
  </div>

  <div class="sec-title" style="margin:24px 0 12px">AI Model for Documents</div>
  <div style="font-size:12px;color:var(--muted);margin-bottom:14px;line-height:1.6">Choose which Claude model powers resume tailoring and cover letter generation. Opus produces the highest-quality, most nuanced output — recommended for roles that matter most.</div>
  <select id="document-model-select" class="input" style="max-width:520px" onchange="setDocumentModel(this.value)">
    <option value="claude-opus-4-6">Opus (Best Quality &mdash; recommended for dream jobs, slower &mdash; 45&ndash;90 sec)</option>
    <option value="claude-sonnet-4-6">Sonnet (Balanced &mdash; fast and high quality, recommended for most applications &mdash; 20&ndash;40 sec)</option>
  </select>
  <div id="document-model-msg" style="font-size:11px;color:#4ade80;margin-top:8px;display:none">Model preference saved.</div>

  <div class="save-row" style="margin-top:24px">
    <button class="btn btn-gold" onclick="saveCriteria()">Save Settings</button>
    <span class="ok-msg" id="settings-msg" style="display:none">Saved!</span>
  </div>
</div>

<div class="panel" id="panel-positioning">
<div class="pos-layout">

  <!-- Step nav -->
  <div class="pos-steps">
    <button class="pos-step-btn active" data-step="intake" onclick="posShowStep('intake')">1. Intake</button>
    <button class="pos-step-btn" data-step="stories" onclick="posShowStep('stories')">2. Story Bank</button>
    <button class="pos-step-btn" data-step="outputs" onclick="posShowStep('outputs')">3. Outputs</button>
    <button class="pos-step-btn" data-step="objections" onclick="posShowStep('objections')">4. Objections</button>
    <button class="pos-step-btn" data-step="narrative" onclick="posShowStep('narrative')">5. Core Narrative</button>
  </div>

  <!-- Step 1: Intake -->
  <div class="pos-section active" id="pos-intake">
    <div class="pos-section-header">
      <div>
        <h2 class="pos-title">Career Positioning Intake</h2>
        <p class="pos-sub">This drives your 8 outbound assets (LinkedIn, pitches, bios, objection handling). It does <em>not</em> affect job search — that's governed by Settings + Resume + Companies.</p>
      </div>
      <button class="btn btn-gold" onclick="saveIntake()">Save Intake</button>
    </div>
    <div class="pos-form-grid">
      <div class="pos-field">
        <label class="pos-label">Target Role <span class="pos-req">*</span></label>
        <input class="pos-input" id="pi-target-role" placeholder="e.g. Enterprise Account Executive, VP of Sales">
      </div>
      <div class="pos-field">
        <label class="pos-label">Target Industry <span class="pos-req">*</span></label>
        <input class="pos-input" id="pi-target-industry" placeholder="e.g. SaaS, Cybersecurity, Data Infrastructure">
      </div>
      <div class="pos-field pos-full">
        <label class="pos-label">Top 5 Measurable Wins <span class="pos-req">*</span></label>
        <textarea class="pos-textarea" id="pi-top-wins" rows="5" placeholder="Be specific with numbers. e.g.&#10;1. Closed $4.2M in enterprise deals in FY2023, 148% of quota&#10;2. Grew territory from $800K to $2.1M ARR in 18 months&#10;3. Won 3 competitive displacements of Salesforce at Fortune 500 accounts..."></textarea>
      </div>
      <div class="pos-field pos-full">
        <label class="pos-label">Strengths</label>
        <textarea class="pos-textarea" id="pi-strengths" rows="3" placeholder="What do you do better than most people at your level? Be honest and specific."></textarea>
      </div>
      <div class="pos-field">
        <label class="pos-label">What You Want Next</label>
        <textarea class="pos-textarea" id="pi-want-next" rows="3" placeholder="Type of company, stage, culture, scope of role, comp expectations..."></textarea>
      </div>
      <div class="pos-field">
        <label class="pos-label">What You Don't Want</label>
        <textarea class="pos-textarea" id="pi-dont-want" rows="3" placeholder="Hard nos: industries, company types, travel, management style, anything non-negotiable..."></textarea>
      </div>
      <div class="pos-field">
        <label class="pos-label">Career Pivot Concerns</label>
        <textarea class="pos-textarea" id="pi-pivot-concerns" rows="3" placeholder="If you're making any kind of shift — what are you worried about being asked or challenged on?"></textarea>
      </div>
      <div class="pos-field">
        <label class="pos-label">Why Now</label>
        <textarea class="pos-textarea" id="pi-why-now" rows="3" placeholder="What's driving the move? Be honest — Claude will use this to create authentic messaging."></textarea>
      </div>
      <div class="pos-field pos-full">
        <label class="pos-label">Biggest Objection You Expect</label>
        <textarea class="pos-textarea" id="pi-biggest-objection" rows="3" placeholder="What do you expect a recruiter or hiring manager to push back on most?"></textarea>
      </div>
    </div>
    <div style="margin-top:20px;display:flex;gap:10px;align-items:center">
      <button class="btn btn-gold" onclick="saveIntake()">Save Intake</button>
      <span class="ok-msg" id="intake-msg" style="display:none">Saved!</span>
    </div>
  </div>

  <!-- Step 2: Story Bank -->
  <div class="pos-section" id="pos-stories">
    <div class="pos-section-header">
      <div>
        <h2 class="pos-title">Story Bank</h2>
        <p class="pos-sub">CAR-format stories that Claude pulls from when generating outputs. More stories = better outputs.</p>
      </div>
      <button class="btn btn-gold" onclick="openStoryModal()">+ Add Story</button>
    </div>
    <div id="story-list" class="pos-story-list">
      <div class="pos-empty">No stories yet. Add your first one.</div>
    </div>
  </div>

  <!-- Step 3: Outputs -->
  <div class="pos-section" id="pos-outputs">
    <div class="pos-section-header">
      <div>
        <h2 class="pos-title">Generated Outputs</h2>
        <p class="pos-sub">All 8 assets generated from your intake + story bank. One source of truth, consistent voice.</p>
      </div>
      <button class="btn btn-gold" onclick="generateOutputs()">&#9889; Generate All</button>
    </div>
    <div id="pos-outputs-status" class="pos-gen-status" style="display:none"></div>
    <div id="pos-outputs-container" class="pos-outputs-grid"></div>
  </div>

  <!-- Step 4: Objection Handling -->
  <div class="pos-section" id="pos-objections">
    <div class="pos-section-header">
      <div>
        <h2 class="pos-title">Objection Handling</h2>
        <p class="pos-sub">The real concerns recruiters and hiring managers will raise — and exactly how to address them.</p>
      </div>
      <button class="btn btn-gold" onclick="generateObjections()">&#9889; Generate Objections</button>
    </div>
    <div id="pos-obj-status" class="pos-gen-status" style="display:none"></div>
    <div id="pos-obj-container"></div>
  </div>

  <!-- Step 5: Core Narrative -->
  <div class="pos-section" id="pos-narrative">
    <div class="pos-section-header">
      <div>
        <h2 class="pos-title">Core Narrative</h2>
        <p class="pos-sub">Once approved, this drives resume tailoring, cover letters, and interview prep across the platform.</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn" style="background:var(--surface);color:var(--text)" onclick="draftNarrative()">&#9889; Draft with AI</button>
        <button class="btn btn-gold" onclick="approveNarrative()">&#10003; Approve &amp; Save</button>
      </div>
    </div>
    <div id="pos-narr-status" class="pos-gen-status" style="display:none"></div>
    <div id="pos-narr-approved-badge" style="display:none" class="pos-approved-badge">&#10003; Narrative Approved</div>
    <div class="pos-narr-grid">
      <div class="pos-narr-field">
        <label class="pos-label">Target Narrative <span style="color:var(--muted);font-size:11px">— who you are, what you do best, where you're going</span></label>
        <textarea class="pos-textarea" id="pn-target-narrative" rows="4" placeholder="Claude will draft this from your intake. You can edit before approving."></textarea>
      </div>
      <div class="pos-narr-field">
        <label class="pos-label">Why Me <span style="color:var(--muted);font-size:11px">— your unique differentiator</span></label>
        <textarea class="pos-textarea" id="pn-why-me" rows="4" placeholder="What you bring that few others can. Specific to your actual background."></textarea>
      </div>
      <div class="pos-narr-field">
        <label class="pos-label">Why Now <span style="color:var(--muted);font-size:11px">— market timing + career readiness</span></label>
        <textarea class="pos-textarea" id="pn-why-now" rows="3" placeholder="Why this is the right moment for your move."></textarea>
      </div>
      <div class="pos-narr-field">
        <label class="pos-label">Category Positioning <span style="color:var(--muted);font-size:11px">— how recruiters should bucket you</span></label>
        <textarea class="pos-textarea" id="pn-category" rows="3" placeholder="What category do you own in a recruiter's mind?"></textarea>
      </div>
      <div class="pos-narr-field pos-narr-full">
        <label class="pos-label">Ideal Role Thesis <span style="color:var(--muted);font-size:11px">— specific enough to guide outreach and tailoring</span></label>
        <textarea class="pos-textarea" id="pn-ideal-role" rows="3" placeholder="Exactly what role you should be targeting and why."></textarea>
      </div>
    </div>
  </div>

</div><!-- /pos-layout -->
</div><!-- /panel-positioning -->

<!-- Story Modal -->
<div class="modal-overlay" id="story-modal" onclick="if(event.target===this)closeStoryModal()">
  <div class="modal" style="max-width:700px">
    <div class="modal-header">
      <span id="story-modal-title" style="font-size:16px;font-weight:600">Add Story</span>
      <button class="btn" style="padding:4px 10px;font-size:12px" onclick="closeStoryModal()">&#x2715;</button>
    </div>
    <input type="hidden" id="story-edit-id">
    <div style="display:flex;flex-direction:column;gap:14px">
      <div>
        <label class="pos-label">Story Title</label>
        <input class="pos-input" id="sm-title" placeholder="e.g. Largest deal close in company history">
      </div>
      <div>
        <label class="pos-label">Context <span style="color:var(--muted);font-size:11px">— situation, stakes, your role</span></label>
        <textarea class="pos-textarea" id="sm-context" rows="2" placeholder="What was the situation? What were the stakes?"></textarea>
      </div>
      <div>
        <label class="pos-label">Action <span style="color:var(--muted);font-size:11px">— specifically what YOU did</span></label>
        <textarea class="pos-textarea" id="sm-action" rows="2" placeholder="What did you do specifically? Be precise about your contribution."></textarea>
      </div>
      <div>
        <label class="pos-label">Result <span style="color:var(--muted);font-size:11px">— measurable outcome</span></label>
        <textarea class="pos-textarea" id="sm-result" rows="2" placeholder="What happened? Use numbers wherever possible."></textarea>
      </div>
      <div>
        <label class="pos-label">Key Metrics</label>
        <input class="pos-input" id="sm-metrics" placeholder="e.g. $2.4M deal, 6-month sales cycle, 3 competitors displaced">
      </div>
      <div>
        <label class="pos-label">Themes <span style="color:var(--muted);font-size:11px">— select all that apply</span></label>
        <div class="pos-theme-pills" id="sm-themes">
          <label class="pos-theme-pill"><input type="checkbox" value="leadership"> Leadership</label>
          <label class="pos-theme-pill"><input type="checkbox" value="ownership"> Ownership</label>
          <label class="pos-theme-pill"><input type="checkbox" value="conflict"> Conflict</label>
          <label class="pos-theme-pill"><input type="checkbox" value="quota"> Quota</label>
          <label class="pos-theme-pill"><input type="checkbox" value="cross-functional"> Cross-functional</label>
          <label class="pos-theme-pill"><input type="checkbox" value="strategy"> Strategy</label>
          <label class="pos-theme-pill"><input type="checkbox" value="execution"> Execution</label>
          <label class="pos-theme-pill"><input type="checkbox" value="resilience"> Resilience</label>
        </div>
      </div>
      <div>
        <label class="pos-label">Confidence Level</label>
        <div style="display:flex;gap:8px">
          <label class="pos-theme-pill"><input type="radio" name="sm-conf" value="1"> 1 – Weak</label>
          <label class="pos-theme-pill"><input type="radio" name="sm-conf" value="2"> 2 – OK</label>
          <label class="pos-theme-pill"><input type="radio" name="sm-conf" value="3" checked> 3 – Good</label>
          <label class="pos-theme-pill"><input type="radio" name="sm-conf" value="4"> 4 – Strong</label>
          <label class="pos-theme-pill"><input type="radio" name="sm-conf" value="5"> 5 – Best</label>
        </div>
      </div>
    </div>
    <div style="margin-top:20px;display:flex;gap:10px">
      <button class="btn btn-gold" onclick="saveStoryModal()">Save Story</button>
      <button class="btn" style="background:var(--surface);color:var(--text)" onclick="closeStoryModal()">Cancel</button>
    </div>
  </div>
</div>

<div class="panel" id="panel-news">
  <div class="news-layout">
    <div class="news-topbar">
      <div>
        <div class="news-title">&#x1F4F0; Industry News</div>
        <div class="news-subtitle">Live B2B tech news &mdash; analyzed by Gemini for hiring signals, funding, and sales opportunity</div>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <div id="news-meta" class="news-status"></div>
        <button class="btn btn-gold btn-sm" id="news-refresh-btn" onclick="refreshNews()">&#x21BB; Refresh Feed</button>
      </div>
    </div>

    <div class="news-filter-bar" id="news-filter-bar">
      <button class="news-filter-btn active" onclick="setNewsFilter('all',this)">All</button>
      <button class="news-filter-btn" onclick="setNewsFilter('SaaS',this)">SaaS</button>
      <button class="news-filter-btn" onclick="setNewsFilter('Cybersecurity',this)">Cybersecurity</button>
      <button class="news-filter-btn" onclick="setNewsFilter('AI',this)">AI</button>
      <button class="news-filter-btn" onclick="setNewsFilter('Infrastructure',this)">Infrastructure</button>
      <button class="news-filter-btn" onclick="setNewsFilter('Hardware',this)">Hardware</button>
      <button class="news-filter-btn" onclick="setNewsFilter('Fintech',this)">Fintech</button>
      <button class="news-filter-btn" onclick="setNewsFilter('HealthTech',this)">HealthTech</button>
      <button class="news-signal-btn hiring" onclick="toggleNewsSignal('hiring',this)">&#x2714; Hiring</button>
      <button class="news-signal-btn funded" onclick="toggleNewsSignal('funded',this)">&#x1F4B0; Funded</button>
    </div>

    <div class="news-grid" id="news-grid">
      <div class="news-loading">Loading news feed&hellip;</div>
    </div>

    <div id="news-footer" class="news-footer"></div>
  </div>
</div>

<div class="panel" id="panel-clawd">
  <iframe class="clawd-frame" src="https://deathbyclawd.com/" allow="fullscreen" loading="lazy"></iframe>
</div>

</div><!-- /main-content -->
</div><!-- /app-body -->

<!-- Tailor Resume V2 Modal -->
<div class="modal-overlay" id="tailor-modal" style="display:none" onclick="if(event.target===this)closeTailorModal()">
  <div class="tr-modal-box">

    <!-- Header -->
    <div class="tr-modal-header">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px">
        <div style="flex:1;min-width:0">
          <div class="tr-modal-title" id="tr-modal-title">Tailored Resume</div>
          <div style="display:flex;align-items:center;gap:10px;margin-top:6px;flex-wrap:wrap">
            <span class="tr-ats-badge" id="tr-ats-badge" style="display:none">ATS Score: <span id="tr-score-before">–</span>% &rarr; <span id="tr-score-after">–</span>%</span>
            <div class="tr-modal-sub">
              <span id="tr-modal-ts"></span>
              <span id="tr-model-badge" style="display:none;font-size:11px;color:var(--muted);background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:2px 9px"></span>
              <span id="tr-cached-badge" style="display:none;color:var(--gold)">&#x2713; Cached</span>
              <button class="btn btn-ghost btn-sm" id="tr-regen-btn" onclick="regenerateTailoredResume()" style="display:none;padding:2px 10px;font-size:11px">&#x21BA; Regenerate</button>
            </div>
          </div>
        </div>
        <button class="modal-close" style="position:static;margin-top:-4px" onclick="closeTailorModal()">&times;</button>
      </div>
    </div>

    <!-- Progress / Loading -->
    <div id="tr-loading" class="tr-progress">
      <div class="spinner" style="margin:0 auto 16px"></div>
      <div class="tr-progress-steps" id="tr-progress-steps">
        <div class="tr-step" id="tr-step-1">
          <div class="tr-step-icon" id="tr-step-1-icon">&#x2022;</div>
          <span>Step 1: Researching ATS requirements &amp; keywords</span>
        </div>
        <div class="tr-step" id="tr-step-2">
          <div class="tr-step-icon" id="tr-step-2-icon">&#x2022;</div>
          <span>Step 2: Analyzing your resume for gaps</span>
        </div>
        <div class="tr-step" id="tr-step-3">
          <div class="tr-step-icon" id="tr-step-3-icon">&#x2022;</div>
          <span>Step 3: Writing your tailored resume</span>
        </div>
      </div>
      <div style="font-size:11px;color:var(--muted);margin-top:16px" id="tr-loading-sub">This takes 30&ndash;60 seconds &mdash; three Claude calls for maximum accuracy</div>
    </div>

    <!-- Error -->
    <div id="tr-error" style="display:none;padding:32px 24px;text-align:center">
      <div style="color:#ff6b6b;font-size:13px;margin-bottom:12px" id="tr-error-msg"></div>
      <button class="btn btn-gold btn-sm" onclick="regenerateTailoredResume()">Try Again</button>
    </div>

    <!-- Tabs (shown when content loaded) -->
    <div class="tr-tabs" id="tr-tabs" style="display:none">
      <div class="tr-tab active" id="tr-tab-resume" onclick="switchTrTab('resume')">Resume</div>
      <div class="tr-tab" id="tr-tab-changed" onclick="switchTrTab('changed')">What Changed</div>
      <div class="tr-tab" id="tr-tab-ats" onclick="switchTrTab('ats')">ATS Analysis</div>
    </div>

    <!-- Tab: Resume -->
    <div class="tr-modal-body" id="tr-panel-resume" style="display:none">
      <div class="tr-resume-wrap" id="tr-resume-text"></div>
    </div>

    <!-- Tab: What Changed -->
    <div class="tr-modal-body" id="tr-panel-changed" style="display:none">
      <div class="tr-section">
        <div class="tr-section-title">Keywords Added</div>
        <div class="tr-keyword-grid" id="tr-kw-added"></div>
      </div>
      <div class="tr-section">
        <div class="tr-section-title">Keywords Already Present</div>
        <div class="tr-keyword-grid" id="tr-kw-present"></div>
      </div>
      <div class="tr-section">
        <div class="tr-section-title">Experiences Highlighted</div>
        <ul class="tr-bullet-list" id="tr-exp-highlight"></ul>
      </div>
      <div class="tr-section" id="tr-downplay-section">
        <div class="tr-section-title">Experiences De-emphasized</div>
        <ul class="tr-bullet-list" id="tr-exp-downplay"></ul>
      </div>
      <div class="tr-section">
        <div class="tr-section-title">Summary Angle</div>
        <div style="font-size:13px;color:var(--text);line-height:1.7;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px" id="tr-summary-angle"></div>
      </div>
    </div>

    <!-- Tab: ATS Analysis -->
    <div class="tr-modal-body" id="tr-panel-ats" style="display:none">
      <div class="tr-section">
        <div class="tr-section-title">Must-Have Keywords</div>
        <div class="tr-keyword-grid" id="tr-ats-must"></div>
      </div>
      <div class="tr-section">
        <div class="tr-section-title">Company-Specific Terms</div>
        <div class="tr-keyword-grid" id="tr-ats-company"></div>
      </div>
      <div class="tr-section" id="tr-ats-requirements-section">
        <div class="tr-section-title">Top Requirements</div>
        <ul class="tr-bullet-list" id="tr-ats-requirements"></ul>
      </div>
      <div class="tr-section" id="tr-buyer-section">
        <div class="tr-section-title">Buyer Persona</div>
        <div style="font-size:13px;color:var(--text);line-height:1.7;background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px 14px" id="tr-buyer-persona"></div>
      </div>
    </div>

    <!-- Footer -->
    <div class="tr-modal-footer" id="tr-footer" style="display:none">
      <button class="btn btn-gold btn-sm" onclick="copyTailoredResume()">&#x1F4CB; Copy Resume</button>
      <button class="btn btn-ghost btn-sm" onclick="downloadTailoredResume()">&#x2B07; Download .txt</button>
      <button class="btn btn-ghost btn-sm" onclick="openCoverLetterForCurrentJob()" style="margin-left:auto">&#x270D; Write Cover Letter</button>
    </div>

  </div>
</div>

<!-- Research Company Modal -->
<div class="modal-overlay" id="research-modal">
  <div class="modal research-modal">
    <div class="modal-header">
      <div></div>
      <button class="modal-close" onclick="closeResearchModal()">&times;</button>
    </div>
    <div id="research-loading" class="research-loading">
      <div class="spinner"></div>
      <p>Researching company with AI-powered web search...</p>
      <p>This takes 15-30 seconds</p>
      <div class="elapsed" id="research-elapsed"></div>
    </div>
    <div id="research-error" class="research-error" style="display:none">
      <p id="research-error-msg"></p>
      <button class="btn btn-gold btn-sm" style="margin-top:12px" onclick="retryResearch()">Retry</button>
    </div>
    <div id="research-content" style="display:none">
      <div class="research-header">
        <div class="research-company-name" id="research-company-name"></div>
        <div class="research-oneliner" id="research-oneliner"></div>
        <div class="research-chips">
          <div class="research-chip"><span class="chip-label">Funding / Valuation</span><span class="chip-val" id="research-funding"></span></div>
          <div class="research-chip"><span class="chip-label">Revenue / Growth</span><span class="chip-val" id="research-revenue"></span></div>
        </div>
        <div class="research-meta" id="research-meta"></div>
      </div>
      <div class="research-tabs" id="research-tabs">
        <div class="research-tab active" onclick="showResearchTab('interview')">Interview Prep</div>
        <div class="research-tab" onclick="showResearchTab('overview')">Overview</div>
        <div class="research-tab" onclick="showResearchTab('market')">Market Position</div>
        <div class="research-tab" onclick="showResearchTab('sales')">Sales Intel</div>
        <div class="research-tab" onclick="showResearchTab('news')">Recent News</div>
        <div class="research-tab" onclick="showResearchTab('scorecard')" style="color:#c8a96e">&#127919; Scorecard</div>
      </div>
      <div class="research-body" id="research-body"></div>
      <div class="research-footer">
        <button class="btn btn-gold btn-sm" id="research-save-btn" onclick="saveResearchBrief()">Save Brief</button>
        <button class="btn btn-ghost btn-sm" onclick="copyFullBrief()">Copy Full Brief</button>
        <a class="btn btn-ghost btn-sm" id="research-careers-link" href="#" target="_blank" rel="noopener">Open Careers Page</a>
      </div>
    </div>
  </div>
</div>

<script>
// ── helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function lines(id) {
  return document.getElementById(id).value.split('\\n').map(function(s){return s.trim();}).filter(Boolean);
}

// ── clawd iframe sizing ───────────────────────────────────────────────────
function sizeClawd() {
  var panel = document.getElementById('panel-clawd');
  var frame = document.querySelector('.clawd-frame');
  if (!panel || !frame) return;
  if (!panel.classList.contains('active')) { frame.style.height = ''; return; }
  var mc = document.querySelector('.main-content');
  var top = mc ? mc.getBoundingClientRect().top : 0;
  frame.style.height = (window.innerHeight - top) + 'px';
}
window.addEventListener('resize', sizeClawd);

// ── tabs ─────────────────────────────────────────────────────────────────
var TABS = ['jobs','saved','pipeline','research','intel','pulse','leaders','deepvalue','preipo','news','companies','resume','email','runs','positioning','settings','clawd'];
function showTab(name) {
  TABS.forEach(function(t) {
    var tabEl = document.getElementById('tab-' + t);
    var panelEl = document.getElementById('panel-' + t);
    if (tabEl) tabEl.classList.toggle('active', t === name);
    if (panelEl) panelEl.classList.toggle('active', t === name);
  });
  sizeClawd();
  if (name === 'jobs')      loadJobs();
  if (name === 'saved')     loadSavedJobs();
  if (name === 'pipeline')  loadPipeline();
  if (name === 'research')  loadSavedResearch();
  if (name === 'runs')      loadRuns();
  if (name === 'companies') loadCompanies();
  if (name === 'resume')    loadResume();
  if (name === 'email')     { loadGmailStatus(); loadEmailPreview(); loadDigestTime(); }
  if (name === 'settings')  loadCriteria();
  if (name === 'intel')     loadCareerIntel();
  if (name === 'pulse')     loadJobMarketPulse();
  if (name === 'leaders')   loadIndustryLeaders();
  if (name === 'deepvalue') loadDeepValue();
  if (name === 'preipo')    loadPreIpo();
  if (name === 'news')      loadNews();
  if (name === 'positioning') loadPositioning();
}

// ── stats ─────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    var res = await fetch('/api/stats');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var s = await res.json();
    document.getElementById('stat-scanned').textContent = s.jobsToday || '0';
    document.getElementById('stat-matches').textContent = s.matchesToday || '0';
    document.getElementById('stat-top').textContent = s.topScore || '0';
    if (s.lastRun && s.lastRun.started_at) {
      document.getElementById('stat-lastrun').textContent = new Date(s.lastRun.started_at).toLocaleString();
      document.getElementById('hdr-status').textContent = 'Last run: ' + new Date(s.lastRun.started_at).toLocaleString();
    }
  } catch(e) {
    console.error('loadStats failed:', e);
  }
}

// ── jobs ─────────────────────────────────────────────────────────────────
var _jobsById = {};
var _allJobs = [];
var _currentJobsTab = 'target';
var _jobsRetries = 0;
function isRemoteInTerritory(loc) {
  if (!loc || !/remote/i.test(loc)) return false;
  var stripped = loc
    .replace(/remote/gi, '')
    .replace(/united states?/gi, '')
    .replace(/\\b(usa?|100%|fully|full[- ]?time|work from home|wfh|anywhere|nationwide|national|the|of|for|only)\\b/gi, '')
    .replace(/[-\u2013,\\s().\\\/;]+/g, ' ')
    .trim();
  var US_ABBREVS = /\\b(AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\\b/;
  return /[a-zA-Z]{3,}/.test(stripped) || US_ABBREVS.test(stripped);
}

function repvueSlug(name) {
  return name.replace(/\\s*\\|.*$/, '').replace(/\\s*\\(.*?\\)\\s*/g, '').replace(/,?\\s*(Inc\\.?|LLC|Ltd\\.?|Corp\\.?|Corporation|Company|Co\\.?)$/i, '').trim().replace(/\\s+/g, '');
}

var _rescoreRunning = false;
var _rescoreTotal = 0;
var _rescoreUnscored = 0;
var _rescore_pollTimer = null;

async function checkRescoreStatus() {
  try {
    var res = await fetch('/api/jobs/rescore-status');
    if (!res.ok) return;
    var data = await res.json();
    _rescoreRunning = data.running;
    _rescoreTotal = data.total || 0;
    _rescoreUnscored = data.unscored || 0;
    var banner = document.getElementById('rescore-banner');
    var btn = document.getElementById('rescore-btn');
    var forceBtn = document.getElementById('force-rescore-btn');
    var msgMain = document.getElementById('rescore-msg-main');
    var msgProg = document.getElementById('rescore-progress-msg');
    if (_rescoreRunning) {
      banner.classList.remove('hidden');
      msgMain.textContent = 'Scoring in progress\u2026';
      var done = _rescoreTotal - _rescoreUnscored;
      msgProg.textContent = done + ' of ' + _rescoreTotal + ' scored \u2014 refresh to see results';
      btn.textContent = 'Scoring\u2026';
      btn.disabled = true;
      if (forceBtn) { forceBtn.disabled = true; forceBtn.textContent = 'Scoring\u2026'; }
      if (!_rescore_pollTimer) _rescore_pollTimer = setInterval(function() { checkRescoreStatus(); loadJobs(); }, 8000);
    } else if (_rescoreUnscored > 0) {
      banner.classList.remove('hidden');
      msgMain.textContent = _rescoreUnscored + ' unscored jobs in your library';
      msgProg.textContent = 'Click "Score All Jobs" to classify them into tiers';
      btn.textContent = 'Score All Jobs';
      btn.disabled = false;
      if (forceBtn) { forceBtn.disabled = false; forceBtn.textContent = '\u21ba Force Rescore'; }
      if (_rescore_pollTimer) { clearInterval(_rescore_pollTimer); _rescore_pollTimer = null; }
    } else {
      banner.classList.add('hidden');
      if (forceBtn) { forceBtn.disabled = false; forceBtn.textContent = '\u21ba Force Rescore'; }
      if (_rescore_pollTimer) { clearInterval(_rescore_pollTimer); _rescore_pollTimer = null; }
    }
  } catch(e) {}
}

async function startRescore(force) {
  var btn = document.getElementById(force ? 'force-rescore-btn' : 'rescore-btn');
  btn.disabled = true;
  btn.textContent = 'Starting\u2026';
  try {
    var url = force ? '/api/jobs/rescore-all?force=true' : '/api/jobs/rescore-all';
    var res = await fetch(url, { method: 'POST' });
    var data = await res.json();
    if (data.started) {
      _rescoreRunning = true;
      if (!_rescore_pollTimer) _rescore_pollTimer = setInterval(function() { checkRescoreStatus(); loadJobs(); }, 8000);
      checkRescoreStatus();
    } else {
      alert(data.message || 'Could not start rescore');
      checkRescoreStatus();
    }
  } catch(e) { alert('Rescore failed: ' + e.message); checkRescoreStatus(); }
}

function tierKey(j) {
  if (!j.opportunity_tier || j.opportunity_tier === 'unscored') return 'unscored';
  var t = j.opportunity_tier;
  if (t === 'Top Target') return 'target';
  if (t === 'Fast Win') return 'win';
  if (t === 'Stretch Role') return 'stretch';
  if (t === 'Probably Skip') return 'skip';
  return 'unscored';
}

function tierCssClass(j) {
  var t = tierKey(j);
  if (t === 'target') return 'card-top-target';
  if (t === 'win') return 'card-fast-win';
  if (t === 'stretch') return 'card-stretch-role';
  if (t === 'skip') return 'card-probably-skip';
  return '';
}

function tierBadgeHtml(j) {
  if (!j.opportunity_tier || j.opportunity_tier === 'unscored') return '';
  var t = j.opportunity_tier;
  var cls = t === 'Top Target' ? 'tier-top-target' : t === 'Fast Win' ? 'tier-fast-win' : t === 'Stretch Role' ? 'tier-stretch-role' : 'tier-probably-skip';
  var icon = t === 'Top Target' ? '&#x1F3AF;' : t === 'Fast Win' ? '&#x26A1;' : t === 'Stretch Role' ? '&#x1F680;' : '&#x1F6AB;';
  return '<span class="tier-badge ' + cls + '">' + icon + ' ' + esc(t) + '</span>';
}

function subScoreColor(pct) {
  if (pct >= 80) return '#00c86e';
  if (pct >= 60) return '#f5c842';
  if (pct >= 40) return '#ff9f43';
  return '#e55353';
}

function subScoresHtml(j) {
  if (!j.sub_scores) return '';
  var s = typeof j.sub_scores === 'string' ? JSON.parse(j.sub_scores) : j.sub_scores;
  var isNewFormat = s.compensationFit !== undefined;
  var rows = '';
  if (isNewFormat) {
    var dims = [
      ['roleFit','Role Fit',30],['companyQuality','Company',25],['compensationFit','Comp Fit',20],
      ['locationFit','Location',15],['territoryFit','Territory',10],['realVsFake','Real Role',10]
    ];
    for (var i = 0; i < dims.length; i++) {
      var key = dims[i][0]; var label = dims[i][1]; var max = dims[i][2];
      var v = (s[key] !== undefined && s[key] !== null) ? Number(s[key]) : 0;
      var pct = Math.round((v / max) * 100);
      var col = subScoreColor(pct);
      rows += '<div class="sub-score-row"><span class="sub-score-label">' + label + '</span><div class="sub-score-bar"><div class="sub-score-fill" style="width:' + pct + '%;background:' + col + '"></div></div><span class="sub-score-val">' + v + '/' + max + '</span></div>';
    }
  } else {
    var legDims = [
      ['roleFit','Role Fit'],['qualificationFit','Qualification'],['companyQuality','Company'],
      ['locationFit','Location'],['hiringUrgency','Hiring Urgency'],
      ['tailoringRequired','Tailoring Needed'],['referralOdds','Referral Odds'],['realVsFake','Real vs Fake']
    ];
    for (var li = 0; li < legDims.length; li++) {
      var lkey = legDims[li][0]; var llabel = legDims[li][1];
      var lv = (s[lkey] !== undefined && s[lkey] !== null) ? Number(s[lkey]) : 5;
      var lpct = Math.round(lv * 10);
      var lcol = subScoreColor(lpct);
      rows += '<div class="sub-score-row"><span class="sub-score-label">' + llabel + '</span><div class="sub-score-bar"><div class="sub-score-fill" style="width:' + lpct + '%;background:' + lcol + '"></div></div><span class="sub-score-val">' + lv + '</span></div>';
    }
  }
  return '<div class="sub-scores" id="ss-' + j.id + '"><div class="sub-score-grid">' + rows + '</div></div>';
}

function toggleSubScores(id) {
  var el = document.getElementById('ss-' + id);
  if (el) el.classList.toggle('open');
}

// ── Opportunity Scorecard — derives 9 richer dimensions from stored data ────
function computeScorecard(j) {
  var s = j.sub_scores ? (typeof j.sub_scores === 'string' ? JSON.parse(j.sub_scores) : j.sub_scores) : null;
  var isNewFmt = s && s.compensationFit !== undefined;

  var roleFitPct, compQualPct, compFitPct, locFitPct, terrFitPct, realPct;
  if (isNewFmt) {
    // v2 format: roleFit/30, companyQuality/25, compensationFit/20, locationFit/15, territoryFit/10
    roleFitPct  = Math.round(((Number(s.roleFit) || 0)         / 30) * 100);
    compQualPct = Math.round(((Number(s.companyQuality) || 0)  / 25) * 100);
    compFitPct  = Math.round(((Number(s.compensationFit) || 0) / 20) * 100);
    locFitPct   = Math.round(((Number(s.locationFit) || 0)     / 15) * 100);
    terrFitPct  = Math.round(((s.territoryFit != null ? Number(s.territoryFit) : 7) / 10) * 100);
    realPct     = Math.round(((Number(s.realVsFake) || 5)      / 10) * 100);
  } else {
    // v1 legacy format or null sub_scores — default to 0 if no data
    roleFitPct  = s ? Math.round(((Number(s.roleFit) || 0)        / 10) * 100) : 0;
    compQualPct = s ? Math.round(((Number(s.companyQuality) || 0) / 10) * 100) : 0;
    compFitPct  = s && s.qualificationFit != null ? Math.round((Number(s.qualificationFit) / 10) * 100) : 50;
    locFitPct   = s ? Math.round(((Number(s.locationFit) || 0)    / 10) * 100) : 0;
    terrFitPct  = 70; // no territory field in v1
    realPct     = s ? Math.round(((Number(s.realVsFake) || 5)     / 10) * 100) : 50;
  }
  // Recompute raw values used later (normalized to same effective scale as pct)
  var compFitRaw   = isNewFmt ? (Number(s.compensationFit) || 0) : 10;
  var realRaw      = s ? (isNewFmt ? (Number(s.realVsFake) || 5) : (Number(s.realVsFake) || 5)) : 5;

  var momScore = (j.momentum_score !== null && j.momentum_score !== undefined) ? Number(j.momentum_score) : null;
  var momPct   = momScore !== null ? Math.round((momScore / 25) * 100) : compQualPct;

  var tier     = j.opportunity_tier || '';
  var vs       = j.validation_status || 'pending';
  var csrc     = j.canonical_source || '';
  var applyUrl = (j.apply_url || '') + (j.canonical_url || '');
  var matchConf = j.recovery_match_confidence ? Number(j.recovery_match_confidence) : null;

  // 1. fit_to_user_settings — role + location + comp + territory
  var fitSettings = Math.round(roleFitPct * 0.38 + locFitPct * 0.30 + compFitPct * 0.22 + terrFitPct * 0.10);

  // 2. fit_to_resume_background — role title/level + JD quality gate
  var fitResume = Math.round(roleFitPct * 0.72 + realPct * 0.28);

  // 3. source_confidence — trust in where the link came from
  var srcConf = 48;
  if (vs === 'validated')       srcConf = 95;
  else if (vs === 'recovered')  srcConf = matchConf ? Math.round(55 + matchConf * 35) : 74;
  else if (/greenhouse\.io|lever\.co|ashbyhq\.com|workday\.com|myworkdayjobs|jobvite\.com|icims\.com|smartrecruiters\.com/i.test(applyUrl)) srcConf = 82;
  else if (csrc === 'ats_direct') srcConf = 80;
  else if (/linkedin\.com/i.test(applyUrl))    srcConf = 52;
  else if (/indeed\.com/i.test(applyUrl))      srcConf = 46;

  // 4. canonical_link_confidence — how good is the specific URL we have
  var linkConf;
  if      (vs === 'validated')                           linkConf = 95;
  else if (vs === 'recovered' && matchConf)              linkConf = Math.round(52 + matchConf * 44);
  else if (vs === 'recovered')                           linkConf = 72;
  else if (vs === 'suspicious' || vs === 'failed')       linkConf = 28;
  else                                                    linkConf = srcConf;

  // 5. company_attractiveness — quality + momentum
  var compAttr = momScore !== null
    ? Math.round(compQualPct * 0.52 + momPct * 0.48)
    : compQualPct;

  // 6. likely_hiring_urgency — posting age + JD authenticity
  var urgency = 50;
  var dateStr = j.date_posted || j.found_at;
  if (dateStr) {
    var daysOld = (Date.now() - new Date(dateStr).getTime()) / 86400000;
    if (daysOld < 2)       urgency = 92;
    else if (daysOld < 5)  urgency = 82;
    else if (daysOld < 10) urgency = 70;
    else if (daysOld < 20) urgency = 58;
    else if (daysOld < 40) urgency = 42;
    else if (daysOld < 70) urgency = 28;
    else                   urgency = 15;
  }
  if (realRaw >= 8)  urgency = Math.min(100, urgency + 8);
  else if (realRaw < 5) urgency = Math.max(0, urgency - 15);

  // 7. ease_of_outreach_path — source openness + company profile
  var outreach = Math.round(srcConf * 0.55 + compAttr * 0.45);
  if (/greenhouse|lever|ashby/i.test(applyUrl)) outreach = Math.min(100, outreach + 8);

  // 8. comp_quality — compensation fit vs stated salary
  var hasSalary    = !!(j.salary && j.salary !== 'Unknown' && j.salary !== 'N/A' && j.salary.trim() !== '');
  var hasEstimate  = !!j.salary_estimate;
  var compQual;
  if (!isNewFmt) {
    compQual = null;
  } else if (hasSalary) {
    compQual = Math.max(30, compFitPct);
  } else if (hasEstimate) {
    compQual = Math.max(20, Math.round(compFitPct * 0.85));
  } else {
    compQual = s && s.compensationFit === 10 ? 50 : compFitPct;
  }

  // 9. career_upside — company strength + role stretch + tier value
  var tierUpside = tier === 'Top Target' ? 88 : tier === 'Fast Win' ? 72 : tier === 'Stretch Role' ? 78 : 38;
  var careerUpside = Math.round(compAttr * 0.42 + roleFitPct * 0.30 + tierUpside * 0.28);

  // Recommended action
  var recAction;
  if (!s || !j.match_score)                             recAction = 'Score this job first';
  else if (tier === 'Probably Skip')                     recAction = 'Low Priority';
  else if (tier === 'Top Target' && srcConf >= 75)       recAction = 'Apply Now';
  else if (tier === 'Top Target' && srcConf < 75)        recAction = 'Verify Link First';
  else if (tier === 'Fast Win' && urgency >= 65)         recAction = 'Apply Now';
  else if (tier === 'Fast Win' && roleFitPct >= 70)      recAction = 'Tailor Resume First';
  else if (tier === 'Fast Win')                          recAction = 'Research Company';
  else if (tier === 'Stretch Role' && compAttr >= 70)    recAction = 'Network In First';
  else if (tier === 'Stretch Role')                      recAction = 'Research + Monitor';
  else if (!hasSalary && !hasEstimate)                   recAction = 'Research Comp First';
  else                                                   recAction = 'Review Before Applying';

  // Key strengths
  var strengths = [];
  if (roleFitPct >= 80)          strengths.push('Strong title and seniority match');
  if (compQualPct >= 72)         strengths.push('Quality company with proven track record');
  if (locFitPct >= 85)           strengths.push('Location and remote preferences align');
  if (urgency >= 78)             strengths.push('Fresh posting — lower competition window');
  if (srcConf >= 80)             strengths.push('Direct ATS source — link reliability high');
  if (momScore !== null && momScore >= 20) strengths.push('Company showing strong growth signals');
  if (hasSalary)                 strengths.push('Salary listed — no comp ambiguity');
  if (careerUpside >= 78)        strengths.push('High career upside and resume value');
  if (vs === 'recovered' || vs === 'validated') strengths.push('Verified canonical job posting');

  // Key risks
  var risks = [];
  if (roleFitPct < 55)           risks.push('Role title or level may not be a close match');
  if (srcConf < 52)              risks.push('Sourced from aggregator — verify posting is live');
  if (dateStr) {
    var dOld = Math.round((Date.now() - new Date(dateStr).getTime()) / 86400000);
    if (dOld > 40)               risks.push('Posting is ' + dOld + ' days old — may already be filled');
  }
  if (j.momentum_warning)        risks.push(j.momentum_warning);
  if (vs === 'suspicious' || vs === 'failed') risks.push('Link validation issue — may be expired');
  if (isNewFmt && s && s.compensationFit < 5 && hasSalary) risks.push('Listed salary may be below your minimum');
  var _scAiScore = j.ai_risk_score != null ? Number(j.ai_risk_score) : (j.ai_risk === 'HIGH' ? 8 : j.ai_risk === 'MEDIUM' ? 5 : 2);
  if (_scAiScore >= 7) risks.push('AI displacement risk ' + _scAiScore + '/10 — this product may be replaced by Claude/GPT');
  if (j.is_hardware === false && compFitPct < 30 && !hasSalary) risks.push('Comp unknown — research before applying');

  return {
    overall_score:            j.match_score || 0,
    tier:                     tier,
    fit_to_user_settings:     fitSettings,
    fit_to_resume_background: fitResume,
    source_confidence:        srcConf,
    canonical_link_confidence:linkConf,
    company_attractiveness:   compAttr,
    likely_hiring_urgency:    urgency,
    ease_of_outreach_path:    outreach,
    comp_quality:             compQual,
    career_upside:            careerUpside,
    recommended_action:       recAction,
    strengths:                strengths,
    risks:                    risks,
  };
}

function scColor(pct) {
  if (pct >= 78) return '#00c86e';
  if (pct >= 58) return '#f5c842';
  if (pct >= 38) return '#ff9f43';
  return '#e55353';
}

function scorecardMiniHtml(j) {
  if (!j.sub_scores && !j.match_score) return '';
  var sc = computeScorecard(j);
  var html = '<div class="sc-mini">';
  var items = [
    ['Role Fit',  sc.fit_to_user_settings],
    ['Company',   sc.company_attractiveness],
    ['Source',    sc.source_confidence],
    ['Urgency',   sc.likely_hiring_urgency],
  ];
  for (var i = 0; i < items.length; i++) {
    var lbl = items[i][0];
    var pct = items[i][1];
    var col = scColor(pct);
    html += '<div class="sc-mini-item"><span class="sc-mini-lbl">' + lbl + '</span><div class="sc-mini-bar"><div class="sc-mini-fill" style="width:' + pct + '%;background:' + col + '"></div></div><span class="sc-mini-val" style="color:' + col + '">' + pct + '</span></div>';
  }
  html += '</div>';
  return html;
}

function recActionHtml(j) {
  if (!j.sub_scores && !j.match_score) return '';
  var sc = computeScorecard(j);
  var ra = sc.recommended_action;
  var col = ra === 'Apply Now' ? '#00c86e' : ra === 'Tailor Resume First' ? '#f5c842' : ra === 'Low Priority' ? '#555' : '#7c8dff';
  return '<span class="rec-step" style="background:' + col + '22;color:' + col + ';border-color:' + col + '44" title="Recommended next step">&#x2192; ' + esc(ra) + '</span>';
}

var _currentSortMode = 'score';
function setSortMode(mode) {
  _currentSortMode = mode;
  renderJobs();
}
function sortJobs(jobs) {
  var sc = computeScorecard;
  return jobs.slice().sort(function(a, b) {
    if (_currentSortMode === 'role_fit') {
      var as = a.sub_scores ? (typeof a.sub_scores === 'string' ? JSON.parse(a.sub_scores) : a.sub_scores) : null;
      var bs = b.sub_scores ? (typeof b.sub_scores === 'string' ? JSON.parse(b.sub_scores) : b.sub_scores) : null;
      return (bs ? (Number(bs.roleFit) || 0) : 0) - (as ? (Number(as.roleFit) || 0) : 0);
    }
    if (_currentSortMode === 'company') {
      return sc(b).company_attractiveness - sc(a).company_attractiveness;
    }
    if (_currentSortMode === 'source') {
      return sc(b).source_confidence - sc(a).source_confidence;
    }
    if (_currentSortMode === 'freshness') {
      var ad = a.date_posted || a.found_at || '2000-01-01';
      var bd = b.date_posted || b.found_at || '2000-01-01';
      return new Date(bd).getTime() - new Date(ad).getTime();
    }
    if (_currentSortMode === 'upside') {
      return sc(b).career_upside - sc(a).career_upside;
    }
    if (_currentSortMode === 'urgency') {
      return sc(b).likely_hiring_urgency - sc(a).likely_hiring_urgency;
    }
    // default: match_score
    return (b.match_score || 0) - (a.match_score || 0);
  });
}

function showJobsTab(tab) {
  _currentJobsTab = tab;
  ['target','win','stretch','skip','all'].forEach(function(t) {
    var el = document.getElementById('jtab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  renderJobs();
}

function isNew(j) {
  // Prefer the API-computed is_new flag (also considers date_posted from source)
  if (j.is_new === true) return true;
  if (!j.found_at) return false;
  var d = new Date(j.found_at);
  return (Date.now() - d.getTime()) < 2 * 24 * 60 * 60 * 1000; // 48h
}

function jobAge(j) {
  // Prefer the actual posting date from the source over our discovery timestamp
  var dateStr = j.date_posted || j.found_at;
  if (!dateStr) return '';
  var d = new Date(dateStr);
  if (isNaN(d.getTime())) d = j.found_at ? new Date(j.found_at) : null;
  if (!d || isNaN(d.getTime())) return '';
  var now = new Date();
  var diff = now.getTime() - d.getTime();
  var mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  var days = Math.floor(hrs / 24);
  if (days < 30) return days + 'd ago';
  return Math.floor(days / 30) + 'mo ago';
}

function formatSalaryEstimate(est) {
  if (!est) return '';
  var bLow = Math.round(est.baseLow / 1000);
  var bHigh = Math.round(est.baseHigh / 1000);
  var oLow = Math.round(est.oteLow / 1000);
  var oHigh = Math.round(est.oteHigh / 1000);
  var tooltip = esc(est.confidence) + ' confidence';
  if (est.sources && est.sources.length) tooltip += ' \\u00B7 Sources: ' + esc(est.sources.join(', '));
  if (est.notes) tooltip += ' \\u00B7 ' + esc(est.notes);
  return '<span class="salary-estimated salary-tooltip"><span class="est-prefix">~</span> $' + bLow + 'k-$' + bHigh + 'k base / $' + oLow + 'k-$' + oHigh + 'k OTE<span class="tooltip-text">' + tooltip + '</span></span>';
}

function renderRepVueBadge(j) {
  if (!j.company) return '';
  var slug = repvueSlug(j.company);
  var url = 'https://www.repvue.com/companies/' + encodeURIComponent(slug);
  return '<a class="repvue-link" href="' + esc(url) + '" target="_blank" rel="noopener" onclick="event.stopPropagation()">RV \\u2197</a>';
}

function renderJobCard(j, opts) {
  opts = opts || {};
  var isSaved = !!j.saved_at;
  var saveLabel = isSaved ? '\u2605 Saved' : '\u2606 Save';
  var saveClass = isSaved ? 'save-btn saved' : 'save-btn';

  // Score chip colour — aligned with new tier thresholds (80/65/45)
  var scoreChipClass = j.match_score >= 80 ? 'score-chip score-green' : j.match_score >= 65 ? 'score-chip score-yellow' : j.match_score >= 45 ? 'score-chip' : 'score-chip score-red';

  // Tier badge
  var tBadge = tierBadgeHtml(j) || '<span style="color:var(--muted);font-size:11px">Unscored</span>';

  // Company line: name · location · age
  var ageTxt = jobAge(j);
  var coLineParts = ['<span class="card-co-name" style="cursor:pointer;text-decoration:underline;text-underline-offset:2px;text-decoration-color:rgba(245,200,66,.3)" title="Filter to ' + esc(j.company) + ' jobs" onclick="filterToCompany(' + JSON.stringify(j.company) + ')">' + esc(j.company) + '</span>'];
  var displayLoc = j.display_location || j.location;
  if (displayLoc) coLineParts.push(esc(displayLoc));
  if (ageTxt) coLineParts.push('<span>' + esc(ageTxt) + '</span>');
  if (isNew(j)) coLineParts.push('<span class="new-pill">\u2728 NEW</span>');
  if (opts.showSavedDate && j.saved_at) coLineParts.push('<span style="font-size:10px">saved ' + new Date(j.saved_at).toLocaleDateString() + '</span>');

  // Salary
  var salaryHtml = '';
  if (j.salary && j.salary !== 'Unknown' && j.salary !== 'N/A' && j.salary.trim() !== '') {
    salaryHtml = '<span class="meta-salary">\uD83D\uDCB0 ' + esc(j.salary) + '</span>';
  } else if (j.salary_estimate) {
    salaryHtml = formatSalaryEstimate(typeof j.salary_estimate === 'string' ? JSON.parse(j.salary_estimate) : j.salary_estimate);
  }

  // AI risk badge — numeric score (0-10) takes priority; fall back to text label
  var aiRiskBadge = '';
  var _aiScore = j.ai_risk_score != null ? Number(j.ai_risk_score) : null;
  var _aiLabel = j.ai_risk && j.ai_risk !== 'unknown' ? j.ai_risk : null;
  if (_aiScore !== null || _aiLabel) {
    var _eff = _aiScore !== null ? _aiScore : (_aiLabel === 'HIGH' ? 8 : _aiLabel === 'MEDIUM' ? 5 : 2);
    var _riskClass = _eff >= 7 ? 'HIGH' : _eff >= 4 ? 'MEDIUM' : 'LOW';
    var _emoji = _eff >= 7 ? '\u26D4' : _eff >= 4 ? '\u26A0\uFE0F' : '\u2705';
    var _scoreStr = _aiScore !== null ? ' ' + _aiScore + '/10' : '';
    var _riskText = _eff >= 7 ? 'AI Risk' + _scoreStr : _eff >= 4 ? 'AI Med' + _scoreStr : 'AI Safe' + _scoreStr;
    var _riskTitle = j.ai_risk_reason ? esc(j.ai_risk_reason) : '';
    aiRiskBadge = '<span class="ai-risk-badge ai-risk-' + _riskClass + '" title="' + _riskTitle + '">' + _emoji + ' ' + _riskText + '</span>';
  }

  // Territory badge
  var territoryBadge = isRemoteInTerritory(j.location) ? '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:4px;font-size:10px;font-weight:600;background:rgba(255,159,67,.12);color:#ff9f43;border:1px solid rgba(255,159,67,.3)" title="Territory role — must be based near listed city">\u26A0 Territory</span>' : '';

  // Source badge
  var srcBadge = j.source ? '<span class="source-badge" data-src="' + esc(j.source) + '">' + esc(j.source) + '</span>' : '';

  // Recovery status badge (replaces old link-confidence badge)
  var validationStatus = j.validation_status || 'pending';
  var linkBroken = j.url_ok === false && validationStatus !== 'recovered' && validationStatus !== 'validated';
  var confidenceBadge = '';
  if (validationStatus === 'recovered') {
    var recovSrc = j.canonical_source || '';
    var recovTitle = recovSrc.includes('ats') ? 'Direct ATS posting recovered from ' + recovSrc
      : recovSrc.includes('company') ? 'Company careers page recovered from ' + recovSrc
      : 'Job posting recovered from alternative source';
    confidenceBadge = '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(0,200,150,.15);color:#00c896;border:1px solid rgba(0,200,150,.35)" title="' + recovTitle + '">\u2714 Recovered</span>';
  } else if (validationStatus === 'validated') {
    confidenceBadge = '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(74,222,128,.1);color:#4ade80;border:1px solid rgba(74,222,128,.25)" title="Job metadata validated from direct ATS source">\u2714 Verified</span>';
  } else if (j.canonical_source === 'ats_direct' || (j.apply_url || '').match(/greenhouse|lever\.co|ashbyhq|workday/i)) {
    confidenceBadge = '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(74,222,128,.06);color:#4ade80;border:1px solid rgba(74,222,128,.18)" title="Direct ATS link">\u2714 Direct</span>';
  }

  // RepVue badge
  var repvueBadge = renderRepVueBadge(j);

  // Freshness / staleness badges (from found_at)
  var urgentBadge = '';
  var staleBadge = '';
  if (j.found_at) {
    var freshHrs = (Date.now() - new Date(j.found_at).getTime()) / 3600000;
    if (freshHrs < 6) {
      urgentBadge = '<span style="display:inline-flex;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:700;background:rgba(0,200,110,.15);color:#00c86e;border:1px solid rgba(0,200,110,.35)" title="Posted just ' + Math.round(freshHrs * 10) / 10 + 'h ago \u2014 apply fast for best chance">\uD83D\uDD25 URGENT</span>';
    } else if (freshHrs > 14 * 24) {
      staleBadge = '<span style="display:inline-flex;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(229,83,83,.1);color:#e55353;border:1px solid rgba(229,83,83,.2)" title="Posted ' + Math.round(freshHrs/24) + ' days ago \u2014 may already be filled">\u23F1 ' + Math.round(freshHrs/24) + 'd old</span>';
    }
  }

  // User action status badge
  var userAction = j.user_action || '';
  var actionColors = { applied: '#4ade80', interested: '#f5c842', interviewing: '#818cf8', rejected: '#e55353', skipped: '#555' };
  var actionLabels = { applied: '\u2713 Applied', interested: '\u2605 Interested', interviewing: '\uD83D\uDCCB Interviewing', rejected: '\u2715 Rejected', skipped: '\u2014 Skipped' };
  var actionBadgeHtml = userAction ? '<span style="display:inline-flex;padding:2px 8px;border-radius:3px;font-size:10px;font-weight:700;background:' + (actionColors[userAction] || '#555') + '22;color:' + (actionColors[userAction] || '#888') + ';border:1px solid ' + (actionColors[userAction] || '#555') + '44">' + (actionLabels[userAction] || userAction) + '</span>' : '';

  // Momentum badge (fresh data from company_momentum join)
  var momentumBadge = '';
  if (j.momentum_score !== undefined && j.momentum_score !== null) {
    var ms = Number(j.momentum_score);
    var msColor = ms >= 20 ? '#00c86e' : ms >= 14 ? '#f5c842' : ms >= 8 ? '#ff9f43' : '#e55353';
    var msLabel = ms >= 20 ? '\u26A1 Hot' : ms >= 14 ? '\u2B06 Growing' : ms >= 8 ? '\u2194 Neutral' : '\u26D4 Caution';
    var msSigs = '';
    if (j.momentum_signals) {
      var sigs = typeof j.momentum_signals === 'string' ? JSON.parse(j.momentum_signals) : j.momentum_signals;
      if (Array.isArray(sigs) && sigs.length) msSigs = sigs.slice(0,2).join(' | ');
    }
    momentumBadge = '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:' + msColor + '22;color:' + msColor + ';border:1px solid ' + msColor + '44" title="Momentum ' + ms + '/25' + (msSigs ? ': ' + msSigs : '') + '">' + msLabel + '</span>';
  }

  // Momentum warning badge
  var momentumWarning = '';
  if (j.momentum_warning) {
    momentumWarning = '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:rgba(229,83,83,.12);color:#e55353;border:1px solid rgba(229,83,83,.3)" title="' + esc(j.momentum_warning) + '">\u26A0 Warning</span>';
  }

  // Sub-scores toggle
  var ssHtml = subScoresHtml(j);
  var ssToggle = j.sub_scores ? '<button class="sub-score-toggle" style="font-size:10px;margin-left:auto" onclick="toggleSubScores(' + j.id + ')">Details</button>' : '';

  // Show "Reach Out" only for Top Target and Fast Win
  var tier = (j.opportunity_tier || '').toLowerCase();
  var showReach = tier.indexOf('top') !== -1 || tier.indexOf('fast') !== -1;
  // Use data-* attributes to avoid escaping issues in onclick
  var reachBtn = showReach ? '<button class="btn btn-reach btn-sm" data-jid="' + j.id + '" data-jtit="' + esc(j.title) + '" data-jco="' + esc(j.company) + '" onclick="openOutreach(this.dataset.jid,this.dataset.jtit,this.dataset.jco)">\u2709 Reach Out</button>' : '';

  var tierClass = tierCssClass(j);

  return '<div class="card ' + tierClass + '">' +
    // ── Tier row: badge + score chip
    '<div class="card-tier-row">' +
      '<span>' + tBadge + '</span>' +
      '<span class="' + scoreChipClass + '">' + esc(j.match_score) + '</span>' +
    '</div>' +
    // ── Title block
    '<div class="card-title-block">' +
      '<div class="card-v2-title">' + esc(j.display_title || j.title) + '</div>' +
      '<div class="card-co-line">' + coLineParts.join('<span style="color:#333;margin:0 1px">&nbsp;\u00B7&nbsp;</span>') + '</div>' +
    '</div>' +
    // ── Signal: Why this fits you
    (j.why_good_fit ? '<div class="card-signal"><div class="signal-label">\uD83C\uDFAF Why this fits you</div><div class="signal-text">' + esc(j.why_good_fit) + '</div></div>' : '') +
    // ── Scorecard mini indicators (4 key dimensions, compact)
    scorecardMiniHtml(j) +
    // ── Meta strip: salary, risk, momentum, territory, source, freshness, action
    '<div class="card-meta-strip">' +
      salaryHtml +
      aiRiskBadge +
      urgentBadge +
      staleBadge +
      actionBadgeHtml +
      momentumBadge +
      momentumWarning +
      territoryBadge +
      srcBadge +
      confidenceBadge +
      repvueBadge +
      ssToggle +
    '</div>' +
    ssHtml +
    // ── Actions
    '<div class="card-foot">' +
      recActionHtml(j) +
      '<a href="' + esc(j.display_url || j.canonical_url || j.apply_url) + '" target="_blank" rel="noopener" class="btn btn-apply btn-sm' + (linkBroken ? ' btn-link-warn' : '') + '" title="' + (linkBroken ? '\u26a0 Link may be broken or expired \u2014 try searching the company careers page' : (validationStatus === 'recovered' || validationStatus === 'validated') ? '\u2714 Verified direct source link' : 'Apply to this job') + '">Apply Now \u2192' + (linkBroken ? ' \u26a0' : '') + '</a>' +
      reachBtn +
      '<button class="btn btn-ghost btn-sm" onclick="tailorResume(' + j.id + ')">Tailor Resume and Write CV</button>' +
      '<button class="btn btn-ghost btn-sm" data-jid="' + j.id + '" data-jtit="' + esc(j.title) + '" data-jco="' + esc(j.company) + '" onclick="openCoverLetter(this.dataset.jid,this.dataset.jtit,this.dataset.jco)">\u270D Cover Letter</button>' +
      '<button class="btn btn-ghost btn-sm" id="research-btn-' + j.id + '" onclick="researchCompany(' + j.id + ')">\uD83D\uDD0D Research</button>' +
      '<select class="btn btn-ghost btn-sm track-status-sel" data-jid="' + j.id + '" onchange="markJobAction(this.dataset.jid,this.value);this.blur()" style="cursor:pointer">' +
        '<option value="">' + (userAction ? '\u21BA Change Status' : '\u2295 Track Status') + '</option>' +
        '<option value="applied"' + (userAction === 'applied' ? ' selected' : '') + '>\u2713 Applied</option>' +
        '<option value="interested"' + (userAction === 'interested' ? ' selected' : '') + '>\u2605 Interested</option>' +
        '<option value="interviewing"' + (userAction === 'interviewing' ? ' selected' : '') + '>\uD83D\uDCCB Interviewing</option>' +
        '<option value="rejected"' + (userAction === 'rejected' ? ' selected' : '') + '>\u2715 Rejected</option>' +
        '<option value="skipped"' + (userAction === 'skipped' ? ' selected' : '') + '>\u2014 Skipped</option>' +
      '</select>' +
      '<button class="' + saveClass + '" onclick="toggleSave(' + j.id + ')" id="save-btn-' + j.id + '">' + saveLabel + '</button>' +
    '</div>' +
  '</div>';
}

function updateTabCounts() {
  var counts = { target:0, win:0, stretch:0, skip:0, unscored:0 };
  _allJobs.forEach(function(j) {
    var k = tierKey(j);
    if (counts[k] !== undefined) counts[k]++;
    else counts.unscored++;
  });
  var allCount = _allJobs.length;
  ['target','win','stretch','skip'].forEach(function(t) {
    var el = document.getElementById('jtab-count-' + t);
    if (el) el.textContent = counts[t] > 0 ? '(' + counts[t] + ')' : '';
  });
  var allEl = document.getElementById('jtab-count-all');
  if (allEl) allEl.textContent = allCount > 0 ? '(' + allCount + ')' : '';
}

function renderJobs() {
  var grid = document.getElementById('jobs-grid');
  var cnt  = document.getElementById('jobs-count');
  var jobs;

  updateTabCounts();

  if (_currentJobsTab === 'all') {
    jobs = sortJobs(_allJobs);
    cnt.textContent = jobs.length + ' job' + (jobs.length !== 1 ? 's' : '') + ' total';
  } else {
    var tierMap = { target:'Top Target', win:'Fast Win', stretch:'Stretch Role', skip:'Probably Skip' };
    var tierLabel = tierMap[_currentJobsTab];
    jobs = sortJobs(_allJobs.filter(function(j) { return tierKey(j) === _currentJobsTab; }));
    var emptyMsg = {
      target: 'No Top Target roles yet \\u2014 run the scout or score your library',
      win: 'No Fast Wins identified yet',
      stretch: 'No Stretch Roles identified yet',
      skip: 'No Probably Skip jobs'
    };
    if (!jobs.length) {
      cnt.textContent = emptyMsg[_currentJobsTab] || 'No jobs in this tier';
      grid.innerHTML = '<div style="padding:48px 24px;text-align:center;color:var(--muted);font-size:13px">' + (emptyMsg[_currentJobsTab] || 'No jobs in this tier') + '</div>';
      return;
    }
    var newCount = jobs.filter(isNew).length;
    cnt.textContent = jobs.length + ' ' + (tierLabel || _currentJobsTab) + (jobs.length !== 1 ? ' roles' : ' role') + (newCount ? ' \\u2014 ' + newCount + ' new' : '');
  }
  if (!jobs || !jobs.length) {
    grid.innerHTML = '<div style="padding:48px 24px;text-align:center;color:var(--muted);font-size:13px">No jobs yet \\u2014 run the scout to find matches</div>';
    return;
  }
  grid.innerHTML = jobs.map(function(j) { return renderJobCard(j, { showNew: true }); }).join('');
}

var _hideLowConfidence = false;

function toggleConfidenceFilter() {
  _hideLowConfidence = !_hideLowConfidence;
  var btn = document.getElementById('conf-filter-btn');
  if (btn) {
    btn.textContent = _hideLowConfidence ? '\uD83D\uDD17 Show broken links' : '\uD83D\uDD17 Hide broken links';
    btn.style.background = _hideLowConfidence ? 'rgba(0,200,150,.12)' : '';
    btn.style.color = _hideLowConfidence ? '#00c896' : '';
    btn.style.borderColor = _hideLowConfidence ? 'rgba(0,200,150,.3)' : '';
  }
  loadJobs();
}

async function loadJobs() {
  try {
    var url = '/api/jobs?min_score=50' + (_hideLowConfidence ? '&hide_low_confidence=true' : '');
    var res = await fetch(url);
    if (!res.ok) {
      var body = '';
      try { body = JSON.stringify(await res.json()); } catch(_){}
      throw new Error('HTTP ' + res.status + (body ? ': ' + body : ''));
    }
    var jobs = await res.json();
    _allJobs = jobs;
    _jobsById = {};
    jobs.forEach(function(j) { _jobsById[j.id] = j; });
    _jobsRetries = 0;
    renderJobs();
    checkRescoreStatus();
  } catch(e) {
    console.error('loadJobs failed:', e);
    _jobsRetries++;
    var cnt = document.getElementById('jobs-count');
    if (_jobsRetries <= 5) {
      cnt.textContent = 'Failed to load jobs (attempt ' + _jobsRetries + '/5) \\u2014 retrying\\u2026';
      setTimeout(loadJobs, 3000);
    } else {
      cnt.textContent = 'Could not load jobs \\u2014 check that the server is running and refresh the page';
      _jobsRetries = 0;
    }
  }
}

async function markJobAction(jobId, action) {
  if (!action) return;
  try {
    var res = await fetch('/api/jobs/' + jobId + '/action', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: action })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var updated = await res.json();
    _jobsById[jobId] = updated;
    for (var i = 0; i < _allJobs.length; i++) {
      if (_allJobs[i].id == jobId) { _allJobs[i] = updated; break; }
    }
    renderJobs();
    // Auto-generate interview prep battle card when moving to interviewing
    if (action === 'interviewing') {
      fetch('/api/jobs/' + jobId + '/interview-prep', { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function() { console.log('[PrepAuto] Battle card generated for job', jobId); })
        .catch(function(e) { console.warn('[PrepAuto] Failed:', e); });
    }
    // Refresh pipeline if it's currently visible
    var pipelinePanel = document.getElementById('panel-pipeline');
    if (pipelinePanel && pipelinePanel.classList.contains('active')) loadPipeline();
  } catch(e) { console.error('markJobAction failed:', e); }
}

// ── Pipeline ───────────────────────────────────────────────────────────────
var _pipelineData = null;
async function loadPipeline() {
  try {
    var res = await fetch('/api/pipeline');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    _pipelineData = await res.json();
    renderPipeline(_pipelineData);
  } catch(e) { console.error('loadPipeline failed:', e); }
}

function renderPipeline(data) {
  var stages = ['interested','applied','interviewing','rejected'];
  var total = 0;
  stages.forEach(function(s) { total += (data[s] || []).length; });
  var emptyEl = document.getElementById('pipeline-empty');
  var colsEl = document.getElementById('pipeline-columns');
  var actionCard = document.getElementById('daily-action-card');
  if (total === 0) {
    if (emptyEl) emptyEl.style.display = '';
    if (colsEl) colsEl.style.display = 'none';
    if (actionCard) actionCard.style.display = 'none';
    return;
  }
  if (emptyEl) emptyEl.style.display = 'none';
  if (colsEl) colsEl.style.display = '';
  if (actionCard) actionCard.style.display = '';
  stages.forEach(function(stage) {
    var jobs = data[stage] || [];
    var countEl = document.getElementById('pipe-count-' + stage);
    if (countEl) countEl.textContent = jobs.length;
    var colEl = document.getElementById('pipe-col-' + stage);
    if (!colEl) return;
    if (!jobs.length) {
      colEl.innerHTML = '<div class="pipeline-empty">None yet</div>';
      return;
    }
    colEl.innerHTML = jobs.map(function(j) { return renderPipelineCard(j, stage); }).join('');
  });
}

function renderPipelineCard(j, stage) {
  var days = j.days_in_stage !== null && j.days_in_stage !== undefined ? Math.round(Number(j.days_in_stage)) : 0;
  var daysLabel = days === 0 ? 'Today' : days === 1 ? '1 day ago' : days + ' days ago';
  var scoreHtml = j.match_score ? '<span style="color:var(--gold);font-weight:700">' + j.match_score + '</span>' : '';
  var hasDocs = Number(j.has_docs) > 0;
  var hasPrep = !!j.interview_prep_at;
  var prepBadge = hasPrep ? '<span class="prep-badge">&#x1F3AF; Prep Ready</span>' : '';
  var docsBadge = hasDocs ? '<span style="display:inline-flex;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;background:rgba(96,165,250,.12);color:#60a5fa;border:1px solid rgba(96,165,250,.25)">&#x1F4C4; Docs</span>' : '';
  var prepBtn = (stage === 'interviewing')
    ? '<button class="btn btn-sm" style="background:rgba(129,140,248,.12);color:#818cf8;border:1px solid rgba(129,140,248,.3);font-size:11px" data-jid="' + j.id + '" data-jtit="' + esc(j.title) + '" data-jco="' + esc(j.company) + '" onclick="openInterviewPrep(this.dataset.jid,this.dataset.jtit,this.dataset.jco)">&#x1F3AF; ' + (hasPrep ? 'View Prep' : 'Gen Prep') + '</button>'
    : '';
  var viewJobsBtn = '<button class="btn btn-ghost btn-sm" style="font-size:11px" onclick="filterToCompany(' + JSON.stringify(j.company) + ')">All ' + esc(j.company) + ' jobs</button>';
  var applyBtn = '<a href="' + esc(j.canonical_url || j.apply_url || '#') + '" target="_blank" class="btn btn-sm" style="background:rgba(245,200,66,.1);color:var(--gold);border:1px solid rgba(245,200,66,.3);font-size:11px">Apply &rarr;</a>';
  return '<div class="pipeline-card">' +
    '<div class="pipeline-card-title">' + esc(j.title) + '</div>' +
    '<div class="pipeline-card-co">' + esc(j.company) + '</div>' +
    '<div class="pipeline-card-meta">' +
      '<span>&#x1F552; ' + esc(daysLabel) + '</span>' +
      (scoreHtml ? '<span>' + scoreHtml + '/100</span>' : '') +
      prepBadge + docsBadge +
    '</div>' +
    '<div class="pipeline-card-actions">' +
      applyBtn + prepBtn + viewJobsBtn +
    '</div>' +
  '</div>';
}

// ── Daily Actions ──────────────────────────────────────────────────────────
async function loadDailyActions() {
  var bodyEl = document.getElementById('daily-action-body');
  var btn = document.getElementById('actions-refresh-btn');
  if (btn) btn.disabled = true;
  if (bodyEl) bodyEl.innerHTML = '<div style="color:var(--muted);font-size:13px">Asking Claude to analyze your pipeline&hellip;</div>';
  try {
    var res = await fetch('/api/pipeline/daily-actions', { method: 'POST' });
    var data = await res.json();
    if (bodyEl) bodyEl.innerHTML = renderDailyActions(data);
  } catch(e) {
    if (bodyEl) bodyEl.innerHTML = '<div style="color:#e55353;font-size:13px">Failed to generate actions. Try again.</div>';
  }
  if (btn) btn.disabled = false;
}

function renderDailyActions(data) {
  if (!data.actions || !data.actions.length) {
    return '<div style="color:var(--muted);font-size:13px;font-style:italic">' + esc(data.message || 'No pipeline data yet.') + '</div>';
  }
  return data.actions.map(function(a) {
    return '<div class="daily-action-item urgency-' + esc(a.urgency || 'low') + '">' +
      '<div class="daily-action-icon">' + esc(a.icon || '•') + '</div>' +
      '<div class="daily-action-text">' + esc(a.action) + '</div>' +
    '</div>';
  }).join('');
}

// ── Interview Prep Modal ───────────────────────────────────────────────────
var _prepJobId = null;
function openInterviewPrep(jobId, title, company) {
  _prepJobId = jobId;
  var overlay = document.getElementById('prep-modal-overlay');
  var titleEl = document.getElementById('prep-modal-title');
  var subEl = document.getElementById('prep-modal-sub');
  var bodyEl = document.getElementById('prep-modal-body');
  if (titleEl) titleEl.textContent = title || 'Interview Prep';
  if (subEl) subEl.textContent = company || '';
  if (bodyEl) bodyEl.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">Loading battle card&hellip;</div>';
  if (overlay) overlay.classList.add('open');
  loadInterviewPrep(jobId);
}

function closePrepModal() {
  var overlay = document.getElementById('prep-modal-overlay');
  if (overlay) overlay.classList.remove('open');
}

async function loadInterviewPrep(jobId) {
  var bodyEl = document.getElementById('prep-modal-body');
  try {
    var res = await fetch('/api/jobs/' + jobId + '/interview-prep');
    var data = await res.json();
    if (!data.prep) {
      if (bodyEl) bodyEl.innerHTML = '<div style="text-align:center;padding:20px">' +
        '<div style="color:var(--muted);margin-bottom:16px">No battle card yet. Generate one now?</div>' +
        '<button class="btn btn-gold" onclick="generateInterviewPrep(' + jobId + ')">&#x1F3AF; Generate Battle Card</button></div>';
      return;
    }
    if (bodyEl) bodyEl.innerHTML = renderBattleCard(data.prep, data.generated_at);
  } catch(e) {
    if (bodyEl) bodyEl.innerHTML = '<div style="color:#e55353;padding:20px">Error loading prep: ' + esc(String(e)) + '</div>';
  }
}

async function generateInterviewPrep(jobId) {
  var bodyEl = document.getElementById('prep-modal-body');
  if (bodyEl) bodyEl.innerHTML = '<div style="text-align:center;padding:40px"><div class="intel-spinner" style="margin:0 auto 12px"></div><div style="color:var(--muted);font-size:13px">Claude is building your battle card&hellip;</div></div>';
  try {
    var res = await fetch('/api/jobs/' + jobId + '/interview-prep', { method: 'POST' });
    var data = await res.json();
    if (data.prep && bodyEl) bodyEl.innerHTML = renderBattleCard(data.prep, null);
    else if (bodyEl) bodyEl.innerHTML = '<div style="color:#e55353;padding:20px">Generation failed. Try again.</div>';
  } catch(e) {
    if (bodyEl) bodyEl.innerHTML = '<div style="color:#e55353;padding:20px">Error: ' + esc(String(e)) + '</div>';
  }
}

function renderBattleCard(prep, generatedAt) {
  var html = '';
  if (prep.company_snapshot) {
    html += '<div class="prep-section"><div class="prep-section-label">Company Snapshot</div><div class="prep-snapshot">' + esc(prep.company_snapshot) + '</div></div>';
  }
  if (prep.your_pitch) {
    html += '<div class="prep-section"><div class="prep-section-label">&#x1F3AF; Your Pitch</div><div class="prep-pitch">' + esc(prep.your_pitch) + '</div></div>';
  }
  if (prep.top_questions && prep.top_questions.length) {
    html += '<div class="prep-section"><div class="prep-section-label">Likely Questions &amp; Your Answers</div>';
    prep.top_questions.forEach(function(q, i) {
      var a = (prep.answer_starters || [])[i] || '';
      html += '<div class="prep-qa-item"><div class="prep-q">Q' + (i+1) + ': ' + esc(q) + '</div>' + (a ? '<div class="prep-a">&#x1F4AC; ' + esc(a) + '</div>' : '') + '</div>';
    });
    html += '</div>';
  }
  if (prep.watch_out && prep.watch_out.length) {
    html += '<div class="prep-section"><div class="prep-section-label">&#x26A0; Watch Out For</div><div class="prep-watchout">' +
      prep.watch_out.map(function(w) { return '\u2022 ' + esc(w); }).join('<br>') + '</div></div>';
  }
  if (generatedAt) {
    html += '<div style="font-size:11px;color:var(--muted);margin-top:12px">Generated ' + new Date(generatedAt).toLocaleDateString() + '</div>';
  }
  return html || '<div style="color:var(--muted);padding:20px;text-align:center">Battle card data incomplete. Try regenerating.</div>';
}

// ── Cross-Page Intelligence ────────────────────────────────────────────────
function filterToCompany(companyName) {
  showTab('jobs');
  setTimeout(function() {
    var allJobs = document.querySelectorAll('.card');
    var found = 0;
    allJobs.forEach(function(card) {
      var coEl = card.querySelector('.card-co-name');
      if (!coEl) return;
      var matches = coEl.textContent.trim().toLowerCase() === companyName.toLowerCase();
      card.style.display = matches ? '' : 'none';
      if (matches) found++;
    });
    var countEl = document.getElementById('jobs-count');
    if (countEl) countEl.textContent = found + ' jobs at ' + companyName + ' \u2014 \u200B<button class="btn btn-ghost btn-sm" style="font-size:11px;margin-left:8px" onclick="clearCompanyFilter()">Clear filter</button>';
  }, 150);
}

function clearCompanyFilter() {
  document.querySelectorAll('.card').forEach(function(card) { card.style.display = ''; });
  updateJobsCountDisplay();
}

function updateJobsCountDisplay() {
  var countEl = document.getElementById('jobs-count');
  if (!countEl || !_allJobs) return;
  var visible = _allJobs.filter(function(j) { return tierKey(j) === _currentJobsTab || _currentJobsTab === 'all'; });
  var newLabel = visible.length + ' ' + (_currentJobsTab === 'target' ? 'TOP TARGET' : _currentJobsTab.toUpperCase()) + ' ROLES';
  countEl.textContent = newLabel;
}

async function loadPreferenceProfile() {
  var loadEl = document.getElementById('pref-loading');
  var outputEl = document.getElementById('pref-output');
  var btnEl = document.getElementById('pref-analyze-btn');
  if (loadEl) loadEl.style.display = '';
  if (outputEl) { outputEl.style.display = 'none'; outputEl.innerHTML = ''; }
  if (btnEl) btnEl.disabled = true;
  try {
    var res = await fetch('/api/jobs/preference-profile');
    var data = await res.json();
    if (loadEl) loadEl.style.display = 'none';
    if (outputEl) { outputEl.style.display = ''; outputEl.innerHTML = renderPreferenceProfile(data); }
  } catch(e) {
    if (loadEl) loadEl.style.display = 'none';
    if (outputEl) { outputEl.style.display = ''; outputEl.innerHTML = '<div style="color:#e55353;font-size:13px">Error: ' + (e.message || String(e)) + '</div>'; }
  }
  if (btnEl) btnEl.disabled = false;
}

function renderPreferenceProfile(data) {
  if (!data.profile) {
    return '<div style="color:var(--muted);font-size:13px;padding:8px 0;font-style:italic">' + esc(data.message || 'Not enough data yet.') + '</div>';
  }
  var breakdown = data.breakdown || {};
  var statPills = Object.entries(breakdown).filter(function(e) { return e[1] > 0; }).map(function(e) {
    var colors = { applied: '#4ade80', interested: '#f5c842', interviewing: '#818cf8', rejected: '#e55353', skipped: '#555' };
    var col = colors[e[0]] || '#888';
    return '<span style="background:' + col + '22;color:' + col + ';border:1px solid ' + col + '44;border-radius:4px;padding:3px 10px;font-size:12px">' + e[0].charAt(0).toUpperCase() + e[0].slice(1) + ': <strong>' + e[1] + '</strong></span>';
  }).join('');
  var profileHtml = esc(data.profile).replace(/\\*\\*([^*]+)\\*\\*/g, '<strong style="color:var(--gold)">$1</strong>').replace(/\\n/g, '<br>');
  return '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px">' + statPills + '</div>' +
    '<div style="background:#0d0d0d;border:1px solid #252525;border-radius:8px;padding:16px;font-size:13px;line-height:1.75;color:var(--text)">' + profileHtml + '</div>' +
    '<div style="font-size:11px;color:var(--muted);margin-top:8px">Based on ' + esc(data.action_count) + ' tracked actions</div>';
}

async function toggleSave(jobId) {
  var j = _jobsById[jobId];
  if (!j) return;
  var isSaved = !!j.saved_at;
  try {
    var res;
    if (isSaved) {
      res = await fetch('/api/jobs/' + jobId + '/save', { method: 'DELETE' });
    } else {
      res = await fetch('/api/jobs/' + jobId + '/save', { method: 'POST' });
    }
    var updated = await res.json();
    // update local data
    _jobsById[jobId] = updated;
    for (var i = 0; i < _allJobs.length; i++) {
      if (_allJobs[i].id === jobId) { _allJobs[i] = updated; break; }
    }
    renderJobs();
  } catch(e) {}
}

// ── saved jobs ────────────────────────────────────────────────────────────
async function loadSavedJobs() {
  try {
    var res = await fetch('/api/jobs/saved');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var jobs = await res.json();
    // update cache
    jobs.forEach(function(j) { _jobsById[j.id] = j; });
    var grid = document.getElementById('saved-grid');
    var cnt  = document.getElementById('saved-count');
    if (!jobs.length) {
      cnt.textContent = 'No saved jobs yet \\u2014 save jobs from the Jobs tab';
      grid.innerHTML = '';
      return;
    }
    cnt.textContent = jobs.length + ' saved job' + (jobs.length !== 1 ? 's' : '');
    grid.innerHTML = jobs.map(function(j) { return renderJobCard(j, { showSavedDate: true }); }).join('');
  } catch(e) {
    console.error('loadSavedJobs failed:', e);
    document.getElementById('saved-count').textContent = 'Failed to load saved jobs';
  }
}

// ── runs ──────────────────────────────────────────────────────────────────
async function loadRuns() {
  var res  = await fetch('/api/scout/status');
  var runs = await res.json();
  var tbody = document.getElementById('runs-body');
  var empty = document.getElementById('runs-empty');
  if (!runs.length) { tbody.innerHTML = ''; empty.style.display = ''; return; }
  empty.style.display = 'none';
  var html = '';
  runs.forEach(function(r) {
    html +=
      '<tr>' +
        '<td>' + esc(r.id) + '</td>' +
        '<td><span class="badge b-' + esc(r.status) + '">' + esc(r.status) + '</span></td>' +
        '<td>' + esc(r.companies_scanned || 0) + '</td>' +
        '<td>' + esc(r.jobs_found) + '</td>' +
        '<td>' + esc(r.matches_found || 0) + '</td>' +
        '<td>' + (r.started_at   ? new Date(r.started_at).toLocaleString()   : '\\u2014') + '</td>' +
        '<td>' + (r.completed_at ? new Date(r.completed_at).toLocaleString() : '\\u2014') + '</td>' +
        '<td style="color:var(--red);font-size:12px">' + esc(r.error || '') + '</td>' +
      '</tr>';
  });
  tbody.innerHTML = html;
  var latest = runs[0];
  if (latest) {
    document.getElementById('dot').className = 'dot' + (latest.status === 'running' ? ' running' : '');
  }
}

// ── Markdown renderer (simple, no deps) ──────────────────────────────────
function renderMarkdown(md) {
  if (!md) return '';
  var reBold = new RegExp('[*][*](.+?)[*][*]', 'g');
  var reItal = new RegExp('[*]([^*]+?)[*]', 'g');
  function inlineEsc(raw) {
    var s = raw.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return s.replace(reBold,'<strong>$1</strong>').replace(reItal,'<em>$1</em>');
  }
  var rows = md.split('\\n');
  var out = [];
  var i = 0;
  while (i < rows.length) {
    var row = rows[i];
    if (/^### /.test(row))     { out.push('<h3>' + inlineEsc(row.slice(4)) + '</h3>'); i++; }
    else if (/^## /.test(row)) { out.push('<h2>' + inlineEsc(row.slice(3)) + '</h2>'); i++; }
    else if (/^# /.test(row))  { out.push('<h1>' + inlineEsc(row.slice(2)) + '</h1>'); i++; }
    else if (/^- /.test(row)) {
      var items = [];
      while (i < rows.length && /^- /.test(rows[i])) {
        items.push('<li>' + inlineEsc(rows[i].slice(2)) + '</li>');
        i++;
      }
      out.push('<ul>' + items.join('') + '</ul>');
    }
    else if (row.trim() === '') { out.push(''); i++; }
    else { out.push('<p>' + inlineEsc(row) + '</p>'); i++; }
  }
  return out.join('\\n');
}
function setRendered(id, mdText) {
  var el = document.getElementById(id);
  el.innerHTML = renderMarkdown(mdText);
  el.dataset.md = mdText;
}
function copyRendered(id) {
  var text = document.getElementById(id).innerText;
  navigator.clipboard.writeText(text);
}
function printResume(id) {
  var el = document.getElementById(id);
  el.classList.add('print-target');
  window.print();
  el.classList.remove('print-target');
}
async function downloadDocx(id, filename) {
  var el = document.getElementById(id);
  var md = el.dataset.md || el.innerText;
  await _postDocxDownload(md, filename);
}
async function downloadDocxFromModal(id, filename) {
  await downloadDocx(id, filename);
}
async function _postDocxDownload(md, filename) {
  try {
    var res = await fetch('/api/download-docx', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: md, filename: filename })
    });
    if (!res.ok) { alert('Download failed'); return; }
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename + '.docx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch(e) { alert('Download error: ' + e.message); }
}

// ── resume ────────────────────────────────────────────────────────────────
var _savedResumes = [];
var _activeResumeId = null;
async function loadResume() {
  var res = await fetch('/api/resume');
  var data = await res.json();
  document.getElementById('resume-text').value = data.resume || '';
  await loadSavedResumes();
}

async function loadSavedResumes() {
  var res = await fetch('/api/resumes');
  var data = await res.json();
  _savedResumes = data.resumes || [];
  _activeResumeId = data.activeId;
  renderResumeDropdown();
  var label = document.getElementById('active-resume-label');
  if (_activeResumeId) {
    var active = _savedResumes.find(function(r){return r.id===_activeResumeId;});
    label.textContent = active ? '— ' + active.name : '';
  } else { label.textContent = ''; }
}

function renderResumeDropdown() {
  var list = document.getElementById('resume-dd-list');
  if (!_savedResumes.length) {
    list.innerHTML = '<div class="resume-dropdown-empty">No saved resumes yet. Name and save one below.</div>';
    return;
  }
  list.innerHTML = _savedResumes.map(function(r){
    var isActive = r.id === _activeResumeId;
    return '<div class="resume-dropdown-item' + (isActive?' active-r':'') + '">' +
      '<div style="flex:1;min-width:0" onclick="activateResume(' + r.id + ')">' +
        '<div class="resume-dd-name">' + esc(r.name) + (isActive?' ✓':'') + '</div>' +
        '<div class="resume-dd-preview">' + esc(r.preview || '') + '</div>' +
      '</div>' +
      '<button class="resume-dd-del" onclick="deleteResume(' + r.id + ',event)" title="Delete">✕</button>' +
    '</div>';
  }).join('');
}

function toggleResumeDropdown() {
  var dd = document.getElementById('resume-dropdown');
  var isOpen = dd.style.display !== 'none';
  dd.style.display = isOpen ? 'none' : '';
  if (!isOpen) {
    // close on outside click
    setTimeout(function(){
      document.addEventListener('click', function closeDD(e){
        if (!document.getElementById('resume-dd-wrap').contains(e.target)) {
          dd.style.display = 'none';
          document.removeEventListener('click', closeDD);
        }
      });
    }, 0);
  }
}

async function activateResume(id) {
  var res = await fetch('/api/resumes/' + id + '/activate', { method:'POST' });
  var data = await res.json();
  if (data.ok) {
    document.getElementById('resume-text').value = data.resume.content;
    document.getElementById('resume-dropdown').style.display = 'none';
    _activeResumeId = id;
    await loadSavedResumes();
  }
}

async function saveNamedResume() {
  var name = document.getElementById('resume-save-name').value.trim();
  var content = document.getElementById('resume-text').value.trim();
  if (!name) { alert('Please enter a name for this resume.'); return; }
  if (!content) { alert('Please paste or upload your resume text first.'); return; }
  var res = await fetch('/api/resumes', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, content}) });
  var data = await res.json();
  if (data.ok) {
    document.getElementById('resume-save-name').value = '';
    await loadSavedResumes();
  }
}

async function deleteResume(id, e) {
  e.stopPropagation();
  if (!confirm('Delete this saved resume?')) return;
  await fetch('/api/resumes/' + id, { method:'DELETE' });
  if (_activeResumeId === id) _activeResumeId = null;
  await loadSavedResumes();
}

async function saveResume() {
  var text = document.getElementById('resume-text').value;
  await fetch('/api/resume', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({resume:text}) });
  var msg = document.getElementById('resume-msg');
  msg.style.display = '';
  setTimeout(function(){ msg.style.display = 'none'; }, 2500);
}

async function uploadResumeFile(input) {
  var file = input.files[0];
  if (!file) return;
  var msg = document.getElementById('upload-msg');
  msg.textContent = 'Uploading and parsing ' + file.name + '…';
  msg.style.color = 'var(--gold)';
  var form = new FormData();
  form.append('file', file);
  try {
    var res = await fetch('/api/resume/upload', { method:'POST', body: form });
    var data = await res.json();
    if (data.error) { msg.textContent = 'Error: ' + data.error; msg.style.color = 'var(--red)'; return; }
    document.getElementById('resume-text').value = data.text;
    msg.textContent = '✓ Saved as "' + data.savedName + '"';
    msg.style.color = '#4ade80';
    _activeResumeId = data.savedId;
    await loadSavedResumes();
    setTimeout(function(){ msg.textContent = ''; }, 5000);
  } catch(e) { msg.textContent = 'Upload failed: ' + e.message; msg.style.color = 'var(--red)'; }
  input.value = '';
}

// ── page target state ──────────────────────────────────────────────────────
var _inlinePageTarget = 1;

function setPageTarget(n) {
  _inlinePageTarget = n;
  document.querySelectorAll('#page-toggle .page-toggle-btn').forEach(function(b) {
    b.classList.toggle('active', Number(b.dataset.pages) === n);
  });
}

// ── analysis display ──────────────────────────────────────────────────────
function renderAnalysis(containerId, analysis) {
  var el = document.getElementById(containerId);
  if (!el || !analysis) return;
  var req = (analysis.requiredSkills || []).map(function(k) {
    return '<span class="tailor-kw">' + k + '</span>';
  }).join('');
  var pref = (analysis.preferredSkills || []).map(function(k) {
    return '<span class="tailor-kw pref">' + k + '</span>';
  }).join('');
  var meth = (analysis.methodologies || []).map(function(k) {
    return '<span class="tailor-kw method">' + k + '</span>';
  }).join('');
  var sigs = (analysis.keySignals || []).map(function(k) {
    return '<span class="tailor-kw signal">' + k + '</span>';
  }).join('');
  var placed = (analysis.keywordsPlaced || []).map(function(k) {
    return '<span class="tailor-kw">' + k + '</span>';
  }).join('');
  var html = '<div class="tailor-analysis-title">AI Tailoring Analysis</div>';
  if (req) html += '<div style="margin-bottom:6px"><span style="font-size:10px;color:var(--muted);display:block;margin-bottom:3px">REQUIRED SKILLS MATCHED</span><div class="tailor-kw-list">' + req + '</div></div>';
  if (pref) html += '<div style="margin-bottom:6px"><span style="font-size:10px;color:var(--muted);display:block;margin-bottom:3px">PREFERRED SKILLS</span><div class="tailor-kw-list">' + pref + '</div></div>';
  if (meth) html += '<div style="margin-bottom:6px"><span style="font-size:10px;color:var(--muted);display:block;margin-bottom:3px">METHODOLOGIES DETECTED</span><div class="tailor-kw-list">' + meth + '</div></div>';
  if (sigs) html += '<div style="margin-bottom:6px"><span style="font-size:10px;color:var(--muted);display:block;margin-bottom:3px">NUANCE SIGNALS</span><div class="tailor-kw-list">' + sigs + '</div></div>';
  if (placed && placed !== req) html += '<div style="margin-bottom:4px"><span style="font-size:10px;color:var(--muted);display:block;margin-bottom:3px">KEYWORDS WOVEN IN</span><div class="tailor-kw-list">' + placed + '</div></div>';
  if (analysis.pageEstimate) html += '<div class="tailor-page-badge">📄 ' + analysis.pageEstimate + '</div>';
  el.innerHTML = html;
  el.style.display = '';
}

async function tailorFromDesc() {
  var resume = document.getElementById('resume-text').value.trim();
  var jobDesc = document.getElementById('job-desc-text').value.trim();
  var msg = document.getElementById('tailor-inline-msg');
  if (!resume) { msg.textContent = 'Please paste your resume first.'; msg.style.color = 'var(--red)'; return; }
  if (!jobDesc) { msg.textContent = 'Please paste a job description.'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Analyzing JD and tailoring with Claude Sonnet (' + _inlinePageTarget + '-page target)...';
  msg.style.color = 'var(--gold)';
  document.getElementById('tailor-result').style.display = 'none';
  document.getElementById('tailor-analysis-inline').style.display = 'none';
  try {
    var payload = { resume: resume, jobDescription: jobDesc, targetPages: _inlinePageTarget };
    var res = await fetch('/api/tailor-freeform', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(payload) });
    var data = await res.json();
    if (data.error) { msg.textContent = 'Error: ' + data.error; msg.style.color = 'var(--red)'; return; }
    setRendered('tailor-result-resume', data.resume_text || '');
    setRendered('tailor-result-cover', data.cover_letter || '');
    setRendered('tailor-result-edits', data.suggested_edits || '');
    if (data.analysis) renderAnalysis('tailor-analysis-inline', data.analysis);
    document.getElementById('tailor-result').style.display = '';
    msg.textContent = '';
  } catch(e) { msg.textContent = 'Error: ' + e.message; msg.style.color = 'var(--red)'; }
}

// ── Tailor Resume V2 Modal ────────────────────────────────────────────────
var _trJobId = null;
var _trJobTitle = '';
var _trCompany = '';
var _trActiveTab = 'resume';

function trEl(id) { return document.getElementById(id); }

function goToResumeTab() { showTab('resume'); closeTailorModal(); }

function closeTailorModal() {
  trEl('tailor-modal').style.display = 'none';
  _trJobId = null;
}

function switchTrTab(tab) {
  _trActiveTab = tab;
  ['resume', 'changed', 'ats'].forEach(function(t) {
    trEl('tr-tab-' + t).classList.toggle('active', t === tab);
    trEl('tr-panel-' + t).style.display = t === tab ? '' : 'none';
  });
}

function trSetStep(step, state) {
  var el = trEl('tr-step-' + step);
  var icon = trEl('tr-step-' + step + '-icon');
  if (!el) return;
  el.className = 'tr-step ' + state;
  if (state === 'active') {
    icon.innerHTML = '<div class="tr-step-spinner"></div>';
  } else if (state === 'done') {
    icon.textContent = '\u2713';
  } else {
    icon.textContent = '\u2022';
  }
}

async function tailorResume(jobId) {
  var j = _jobsById[jobId] || {};
  _trJobId = jobId;
  _trJobTitle = j.title || '';
  _trCompany = j.company || '';

  trEl('tr-modal-title').textContent = 'Tailoring Resume \u2014 ' + _trJobTitle + ' at ' + _trCompany;
  trEl('tr-ats-badge').style.display = 'none';
  trEl('tr-model-badge').style.display = 'none';
  trEl('tr-cached-badge').style.display = 'none';
  trEl('tr-regen-btn').style.display = 'none';
  trEl('tr-modal-ts').textContent = '';
  trEl('tr-loading').style.display = '';
  trEl('tr-error').style.display = 'none';
  trEl('tr-tabs').style.display = 'none';
  trEl('tr-panel-resume').style.display = 'none';
  trEl('tr-panel-changed').style.display = 'none';
  trEl('tr-panel-ats').style.display = 'none';
  trEl('tr-footer').style.display = 'none';
  trSetStep(1, ''); trSetStep(2, ''); trSetStep(3, '');
  trEl('tailor-modal').style.display = 'flex';

  // Set model-aware loading subtitle
  try {
    var mr2 = await fetch('/api/settings/document_model');
    var md2 = await mr2.json();
    setTrLoadingText(md2.value || 'claude-opus-4-6');
  } catch(e2) { setTrLoadingText('claude-opus-4-6'); }

  fetchTailoredResume(false);
}

function setTrLoadingText(model) {
  var subEl = trEl('tr-loading-sub');
  if (!subEl) return;
  var isOpus = model.includes('opus');
  subEl.textContent = isOpus
    ? 'Writing with Opus \u2014 three Claude calls for maximum accuracy \u2014 45\u201390 seconds'
    : 'Writing with Sonnet \u2014 three Claude calls for speed and quality \u2014 20\u201340 seconds';
}

async function regenerateTailoredResume() {
  if (!_trJobId) return;
  trEl('tr-loading').style.display = '';
  trEl('tr-error').style.display = 'none';
  trEl('tr-tabs').style.display = 'none';
  trEl('tr-panel-resume').style.display = 'none';
  trEl('tr-panel-changed').style.display = 'none';
  trEl('tr-panel-ats').style.display = 'none';
  trEl('tr-footer').style.display = 'none';
  trEl('tr-cached-badge').style.display = 'none';
  trEl('tr-regen-btn').style.display = 'none';
  trEl('tr-ats-badge').style.display = 'none';
  trEl('tr-model-badge').style.display = 'none';
  trSetStep(1, ''); trSetStep(2, ''); trSetStep(3, '');
  try {
    var mr3 = await fetch('/api/settings/document_model');
    var md3 = await mr3.json();
    setTrLoadingText(md3.value || 'claude-opus-4-6');
  } catch(e3) { setTrLoadingText('claude-opus-4-6'); }
  fetchTailoredResume(true);
}

async function fetchTailoredResume(force) {
  // Animate steps as the server runs (best-effort timing simulation)
  trSetStep(1, 'active');
  var step1Done = false, step2Done = false;
  var stepTimer = setTimeout(function() {
    if (!step1Done) { trSetStep(1, 'done'); step1Done = true; trSetStep(2, 'active'); }
    setTimeout(function() {
      if (!step2Done) { trSetStep(2, 'done'); step2Done = true; trSetStep(3, 'active'); }
    }, 15000);
  }, 12000);

  try {
    var url = '/api/jobs/' + _trJobId + '/tailor-resume' + (force ? '?force=true' : '');
    var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    clearTimeout(stepTimer);
    var json = await res.json();

    if (!res.ok) {
      if (json.error === 'NO_RESUME') {
        showTrError(json.message + ' <a href="#" onclick="goToResumeTab();return false" style="color:var(--gold)">Go to Resume page</a>');
      } else {
        showTrError(json.error || 'Failed to tailor resume');
      }
      return;
    }

    // Animate steps done
    trSetStep(1, 'done'); trSetStep(2, 'done'); trSetStep(3, 'done');
    setTimeout(function() { renderTailoredResume(json); }, 400);
  } catch(e) {
    clearTimeout(stepTimer);
    showTrError('Network error: ' + e.message);
  }
}

function renderTailoredResume(data) {
  // Resume text
  trEl('tr-resume-text').textContent = data.resume_text || '';

  // ATS scores
  var ga = data.gap_analysis || {};
  if (ga.atsScore != null && ga.projectedScore != null) {
    trEl('tr-score-before').textContent = ga.atsScore;
    trEl('tr-score-after').textContent = ga.projectedScore;
    trEl('tr-ats-badge').style.display = '';
  }

  // Metadata
  var ts = data.created_at ? new Date(data.created_at).toLocaleString() : '';
  trEl('tr-modal-ts').textContent = ts || '';
  var trBadge = trEl('tr-model-badge');
  if (trBadge && data.model) { trBadge.textContent = modelLabel(data.model); trBadge.style.display = ''; }
  else if (trBadge) trBadge.style.display = 'none';
  trEl('tr-cached-badge').style.display = data.cached ? '' : 'none';
  trEl('tr-regen-btn').style.display = '';

  // What Changed tab
  var ar = data.ats_research || {};
  var added = ga.keywordsMissing || [];
  var present = ga.keywordsPresent || [];
  trEl('tr-kw-added').innerHTML = added.map(function(k) { return '<span class="tr-kw missing">' + esc(k) + '</span>'; }).join('') || '<span style="font-size:12px;color:var(--muted)">None detected</span>';
  trEl('tr-kw-present').innerHTML = present.map(function(k) { return '<span class="tr-kw present">' + esc(k) + '</span>'; }).join('') || '<span style="font-size:12px;color:var(--muted)">None detected</span>';
  var highlights = ga.experienceToHighlight || [];
  trEl('tr-exp-highlight').innerHTML = highlights.map(function(h) { return '<li data-icon="\u2191">' + esc(h) + '</li>'; }).join('') || '<li data-icon="\u2022" style="color:var(--muted)">None identified</li>';
  var downplay = ga.experienceToDownplay || [];
  trEl('tr-exp-downplay').innerHTML = downplay.map(function(h) { return '<li data-icon="\u2193">' + esc(h) + '</li>'; }).join('') || '<li data-icon="\u2022" style="color:var(--muted)">None identified</li>';
  trEl('tr-downplay-section').style.display = downplay.length ? '' : 'none';
  trEl('tr-summary-angle').textContent = ga.summaryAngle || '';

  // ATS Analysis tab
  var mustHave = ar.mustHaveKeywords || [];
  var gaPresentSet = new Set((ga.keywordsPresent || []).map(function(k) { return k.toLowerCase(); }));
  trEl('tr-ats-must').innerHTML = mustHave.map(function(k) {
    var cls = gaPresentSet.has(k.toLowerCase()) ? 'present' : 'missing';
    return '<span class="tr-kw ' + cls + '">' + esc(k) + '</span>';
  }).join('') || '<span style="font-size:12px;color:var(--muted)">N/A</span>';
  var compTerms = ar.companySpecificTerms || [];
  trEl('tr-ats-company').innerHTML = compTerms.map(function(k) { return '<span class="tr-kw company">' + esc(k) + '</span>'; }).join('') || '<span style="font-size:12px;color:var(--muted)">N/A</span>';
  var topReqs = ar.topRequirements || [];
  trEl('tr-ats-requirements').innerHTML = topReqs.map(function(r) { return '<li data-icon="\u2022">' + esc(r) + '</li>'; }).join('');
  trEl('tr-ats-requirements-section').style.display = topReqs.length ? '' : 'none';
  trEl('tr-buyer-persona').textContent = ar.buyerPersona || '';
  trEl('tr-buyer-section').style.display = ar.buyerPersona ? '' : 'none';

  // Show content
  trEl('tr-loading').style.display = 'none';
  trEl('tr-error').style.display = 'none';
  trEl('tr-tabs').style.display = '';
  switchTrTab('resume');
  trEl('tr-footer').style.display = '';
}

function showTrError(msg) {
  trEl('tr-loading').style.display = 'none';
  trEl('tr-error-msg').innerHTML = msg;
  trEl('tr-error').style.display = '';
  trEl('tr-regen-btn').style.display = '';
}

function copyTailoredResume() {
  var txt = trEl('tr-resume-text').textContent || '';
  if (!txt.trim()) return;
  navigator.clipboard.writeText(txt).then(function() {
    var btn = trEl('tailor-modal').querySelector('button[onclick="copyTailoredResume()"]');
    if (btn) { var orig = btn.textContent; btn.textContent = '\u2713 Copied!'; setTimeout(function() { btn.textContent = orig; }, 1800); }
  }).catch(function() {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  });
}

function downloadTailoredResume() {
  var txt = trEl('tr-resume-text').textContent || '';
  if (!txt.trim()) return;
  var date = new Date().toISOString().slice(0, 10);
  var safeCo = (_trCompany || 'Company').replace(/[^a-zA-Z0-9]/g, '_');
  var filename = 'Resume_Tailored_' + safeCo + '_' + date + '.txt';
  var blob = new Blob([txt], { type: 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = filename; a.click();
  URL.revokeObjectURL(a.href);
}

function openCoverLetterForCurrentJob() {
  if (!_trJobId) return;
  closeTailorModal();
  openCoverLetter(_trJobId, _trJobTitle, _trCompany);
}

// ── gmail ──────────────────────────────────────────────────────────────────
async function loadGmailStatus() {
  try {
    var res = await fetch('/api/gmail/status');
    var data = await res.json();
    var badge = document.getElementById('gmail-badge');
    var connectBtn = document.getElementById('gmail-connect-btn');
    var disconnectBtn = document.getElementById('gmail-disconnect-btn');
    var statusText = document.getElementById('gmail-status-text');
    if (data.connected) {
      if (badge) { badge.textContent = 'Gmail: Connected'; badge.className = 'gmail-badge on'; }
      if (connectBtn) connectBtn.style.display = 'none';
      if (disconnectBtn) disconnectBtn.style.display = '';
      if (statusText) { statusText.textContent = 'Connected'; statusText.style.color = 'var(--green)'; }
    } else {
      if (badge) { badge.textContent = 'Gmail: Not Connected'; badge.className = 'gmail-badge off'; }
      if (connectBtn) connectBtn.style.display = '';
      if (disconnectBtn) disconnectBtn.style.display = 'none';
      if (statusText) { statusText.textContent = 'Not connected \u2014 click Connect Gmail to authorize'; statusText.style.color = 'var(--red)'; }
    }
  } catch(e) {}
  // Load weekly send schedule
  try {
    var ws = await fetch('/api/gmail/weekly-status');
    var wd = await ws.json();
    var nextEl = document.getElementById('email-next-send');
    var lastEl = document.getElementById('email-last-sent');
    if (nextEl && wd.nextSend) {
      var nextD = new Date(wd.nextSend);
      nextEl.textContent = nextD.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }) + ' at ' + (wd.sendTime || '07:00');
    }
    if (lastEl) {
      lastEl.textContent = wd.lastSent ? new Date(wd.lastSent).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }) : 'Never sent yet';
    }
  } catch(e2) {}
}
async function connectGmail() {
  var res = await fetch('/api/gmail/auth-url');
  var data = await res.json();
  window.open(data.url, '_blank');
}
async function disconnectGmail() {
  await fetch('/api/gmail/disconnect', { method: 'POST' });
  loadGmailStatus();
}
async function sendTestDigest() {
  var msg = document.getElementById('test-email-msg');
  msg.textContent = 'Sending...';
  try {
    var res = await fetch('/api/gmail/send-test', { method: 'POST' });
    var data = await res.json();
    msg.textContent = data.message || data.error || 'Done';
    msg.style.color = res.ok ? 'var(--green)' : 'var(--red)';
  } catch(e) {
    msg.textContent = 'Error: ' + e.message;
    msg.style.color = 'var(--red)';
  }
}
async function loadEmailPreview() {
  try {
    var res = await fetch('/api/gmail/preview');
    var data = await res.json();
    document.getElementById('email-preview').innerHTML = data.html || '<div style="color:var(--muted)">No preview available</div>';
    // inject copy buttons on each job card
    document.querySelectorAll('.digest-job[data-job]').forEach(function(el) {
      var btn = document.createElement('button');
      btn.textContent = 'Copy';
      btn.className = 'btn btn-ghost btn-sm';
      btn.style.cssText = 'position:absolute;top:12px;right:12px;font-size:11px;padding:3px 10px';
      btn.onclick = function() {
        try {
          var d = JSON.parse(el.getAttribute('data-job'));
          var text = d.title + '\\n' + d.company + '\\n' + d.location + (d.salary ? '\\n' + d.salary : '') + '\\nScore: ' + d.score + '/100' + (d.why ? '\\n' + d.why : '') + '\\n' + d.url;
          navigator.clipboard.writeText(text);
          btn.textContent = 'Copied!';
          setTimeout(function(){ btn.textContent = 'Copy'; }, 1500);
        } catch(e) {}
      };
      el.appendChild(btn);
    });
  } catch(e) {}
}
async function loadDigestTime() {
  try {
    var res = await fetch('/api/settings/digest_time');
    var data = await res.json();
    if (data.value) document.getElementById('digest-time').value = data.value;
  } catch(e) {}
}
async function saveDigestTime() {
  var time = document.getElementById('digest-time').value;
  await fetch('/api/settings/digest_time', { method: 'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({value:time}) });
  var msg = document.getElementById('digest-time-msg');
  msg.style.display = '';
  setTimeout(function(){ msg.style.display = 'none'; }, 2500);
}

// ── companies ─────────────────────────────────────────────────────────────
async function loadCompanies() {
  await loadCwJobStatus();
  var res = await fetch('/api/companies');
  var cos = await res.json();
  var list = document.getElementById('company-list');
  if (!cos.length) { list.innerHTML = '<div class="empty" style="grid-column:1/-1">No companies yet — add one below.</div>'; return; }
  // Count open roles per company from in-memory jobs (if loaded)
  var jobCountsByCompany = {};
  if (_allJobs && _allJobs.length) {
    _allJobs.forEach(function(j) {
      if (!j.company) return;
      var key = j.company.toLowerCase();
      jobCountsByCompany[key] = (jobCountsByCompany[key] || 0) + 1;
    });
  }
  var cards = cos.map(function(c) {
    var status = c.detect_status || 'manual';
    var statusCls = status === 'detected' ? 'cw-card-status-verified' : status === 'pending' ? 'cw-card-status-pending' : status === 'failed' ? 'cw-card-status-failed' : 'cw-card-status-manual';
    var statusLabel = status === 'detected' ? '\u2713 Verified' : status === 'pending' ? '\u23F3 Pending' : status === 'failed' ? '\u2717 Failed' : '\u270E Manual';
    var atsLabel = c.ats_type ? c.ats_type.charAt(0).toUpperCase() + c.ats_type.slice(1) : 'Unknown';
    var careersDetail = c.careers_url || (c.ats_slug ? atsLabel + ' / ' + c.ats_slug : '');
    var careersHtml = careersDetail
      ? '<div class="cw-card-careers">' +
          '<div class="cw-card-careers-label">Careers / ATS</div>' +
          (c.careers_url
            ? '<a class="cw-card-url" href="' + esc(c.careers_url) + '" target="_blank" rel="noopener">' + esc(c.careers_url.replace(/^https?:\\/\\//, '')) + '</a>'
            : '<div class="cw-card-careers-url">' + esc(careersDetail) + '</div>') +
        '</div>'
      : '<div class="cw-card-careers"><div class="cw-card-careers-label">Careers / ATS</div><div style="font-size:12px;color:var(--muted);font-style:italic">Not yet detected</div></div>';
    var errorHtml = (status === 'failed' || status === 'pending') && c.last_scan_error
      ? '<div style="font-size:11px;color:#ef444499;padding:4px 0">' + esc(c.last_scan_error.slice(0, 100)) + (c.last_scan_error.length > 100 ? '\u2026' : '') + '</div>'
      : '';
    var jobCount = jobCountsByCompany[c.name.toLowerCase()] || 0;
    var jobCountHtml = jobCount > 0
      ? '<button class="btn btn-sm" style="background:rgba(245,200,66,.1);color:var(--gold);border:1px solid rgba(245,200,66,.25);font-size:11px" onclick="filterToCompany(' + JSON.stringify(c.name) + ')">' + jobCount + ' job' + (jobCount !== 1 ? 's' : '') + ' in Scout \u2192</button>'
      : '';
    var scanEntry = _cwJobStatus[c.name.toLowerCase()];
    var scanHtml = '';
    if (scanEntry) {
      var scannedAt = scanEntry.scanned_at ? new Date(scanEntry.scanned_at).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '';
      if (scanEntry.jobs && scanEntry.jobs.length > 0) {
        var roleLinks = scanEntry.jobs.slice(0, 3).map(function(j) {
          var href = j.apply_url || '#';
          return '<a class="cw-role-badge" href="' + esc(href) + '" target="_blank" rel="noopener">\u2713 ' + esc(j.title) + (j.location ? ' \u2014 ' + esc(j.location) : '') + '</a>';
        }).join('');
        var moreCount = scanEntry.jobs.length - 3;
        scanHtml = '<div class="cw-card-jobs"><div class="cw-job-status">' + roleLinks + (moreCount > 0 ? '<span style="font-size:11px;color:var(--muted)">+' + moreCount + ' more</span>' : '') + '</div><div class="cw-scan-status">Deep Scan: ' + scannedAt + '</div></div>';
      } else {
        scanHtml = '<div class="cw-card-jobs"><div class="cw-job-status"><span class="cw-no-roles-badge">\u26A0\uFE0F No matching roles found by deep scan</span></div><div class="cw-scan-status">Deep Scan: ' + scannedAt + '</div></div>';
      }
    }
    return '<div class="cw-card">' +
      '<div class="cw-card-header">' +
        '<div>' +
          '<div class="cw-card-name">' + esc(c.name) + '</div>' +
          '<span class="' + statusCls + '">' + statusLabel + ' \u00B7 ' + esc(atsLabel) + '</span>' +
        '</div>' +
        '<div style="display:flex;gap:4px">' +
          '<button class="btn btn-ghost btn-sm" onclick="rescanCareersPage(' + c.id + ',' + JSON.stringify(c.name) + ',this)" title="Re-detect careers page" style="font-size:11px">\u21BB Rescan</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="deleteCompany(' + c.id + ')" style="font-size:11px;color:#ef4444">Remove</button>' +
        '</div>' +
      '</div>' +
      careersHtml +
      errorHtml +
      (jobCountHtml ? '<div>' + jobCountHtml + '</div>' : '') +
      scanHtml +
    '</div>';
  });
  list.innerHTML = cards.join('');
}
async function addCompanyAuto() {
  var name = document.getElementById('co-name').value.trim();
  var website = document.getElementById('co-website').value.trim();
  if (!name) { alert('Company name is required.'); return; }
  var btn = document.getElementById('co-add-btn');
  var statusEl = document.getElementById('co-detect-status');
  btn.disabled = true;
  statusEl.textContent = 'Asking AI to detect job board…';
  statusEl.style.color = 'var(--muted)';
  try {
    var res = await fetch('/api/companies/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, website: website || undefined })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Detection failed');
    if (data.detected) {
      var atsParts = [data.ats_type, data.ats_slug || data.careers_url].filter(Boolean).join('/');
      statusEl.textContent = '✓ Detected: ' + atsParts + (data.confidence ? ' (' + data.confidence + ' confidence)' : '');
      statusEl.style.color = 'var(--green)';
    } else {
      statusEl.textContent = data.message || 'Saved with best guess — will retry on next scout run.';
      statusEl.style.color = '#f5a623';
    }
    document.getElementById('co-name').value = '';
    document.getElementById('co-website').value = '';
    loadCompanies();
    setTimeout(function() { statusEl.textContent = ''; }, 8000);
  } catch(e) {
    statusEl.textContent = 'Error: ' + (e.message || String(e));
    statusEl.style.color = 'var(--red)';
  }
  btn.disabled = false;
}
async function retryDetect(id, name) {
  if (!confirm('Re-run auto-detection for ' + name + '?')) return;
  // Remove old entry and re-add with fresh detection
  await fetch('/api/companies/' + id, { method: 'DELETE' });
  document.getElementById('co-name').value = name;
  addCompanyAuto();
}
async function deleteCompany(id) {
  await fetch('/api/companies/' + id, { method:'DELETE' });
  loadCompanies();
}

async function rescanCareersPage(id, name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '\u21BB\u2026'; }
  await fetch('/api/companies/' + id, { method: 'DELETE' });
  document.getElementById('co-name').value = name;
  await addCompanyAuto();
  if (btn) { btn.disabled = false; btn.textContent = '\u21BB Rescan'; }
}

// ── Unified Save-to-Watchlist (used by all intel pages) ───────────────────
var _watchlistAdded = {};

async function saveToWatchlist(name, website, btn) {
  if (!name) return;
  var key = name.toLowerCase();
  if (_watchlistAdded[key]) return;
  try {
    if (btn) { btn.disabled = true; btn.textContent = 'Saving\u2026'; }
    var res = await fetch('/api/companies/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, website: website || undefined })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    _watchlistAdded[key] = true;
    if (btn) { btn.textContent = '\u2713 Saved'; btn.classList.add('saved'); btn.disabled = true; }
  } catch(e) {
    if (btn) { btn.textContent = 'Retry?'; btn.disabled = false; }
    console.error('saveToWatchlist failed:', e);
  }
}

// ── run scout ─────────────────────────────────────────────────────────────
var pollTimer = null;
async function runScout() {
  var btn = document.getElementById('run-btn');
  var msg = document.getElementById('run-msg');
  var stageEl = document.getElementById('run-stage');
  var autoEl = document.getElementById('auto-run-badge');
  btn.disabled = true;
  stageEl.style.display = 'none';
  msg.textContent = 'Starting\u2026';
  try {
    var res = await fetch('/api/scout/run', { method:'POST' });
    if (!res.ok) {
      var d = await res.json();
      msg.textContent = d.error || 'Error starting run';
      btn.disabled = false;
      return;
    }
  } catch(e) {
    msg.textContent = 'Network error: ' + e.message;
    btn.disabled = false;
    return;
  }
  document.getElementById('dot').className = 'dot running';
  if (autoEl) autoEl.style.display = 'none';
  msg.textContent = 'Scouting\u2026';
  var jobRefreshTimer = null;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async function() {
    try {
      var r = await fetch('/api/scout/status');
      var runs = await r.json();
      var latest = runs[0];
      if (!latest) return;
      // Show live stage
      if (latest.current_stage && stageEl) {
        stageEl.textContent = latest.current_stage;
        stageEl.style.display = 'inline';
      }
      if (latest.status !== 'running') {
        clearInterval(pollTimer); pollTimer = null;
        if (jobRefreshTimer) { clearInterval(jobRefreshTimer); jobRefreshTimer = null; }
        btn.disabled = false;
        stageEl.style.display = 'none';
        document.getElementById('dot').className = 'dot';
        _jobsRetries = 0;
        loadStats();
        loadAutoRunBadge();
        if (latest.status === 'completed') {
          var found = latest.matches_found || latest.jobs_found;
          msg.textContent = 'Done! ' + found + ' new match' + (found !== 1 ? 'es' : '') + ' found';
          loadJobs().then(function() {
            if (_allJobs.length > found) {
              msg.textContent = 'Done! ' + found + ' new match' + (found !== 1 ? 'es' : '') + ' (\u2022 ' + _allJobs.length + ' total)';
            }
          });
        } else {
          msg.textContent = 'Run failed: ' + (latest.error || 'unknown error');
        }
      }
    } catch(e) {}
  }, 3000);
  // Auto-refresh job list every 45s during scan so user sees jobs as they're scored
  jobRefreshTimer = setInterval(function() {
    if (pollTimer) loadJobs().catch(function(){});
    else { clearInterval(jobRefreshTimer); jobRefreshTimer = null; }
  }, 45000);
}

async function loadAutoRunBadge() {
  try {
    var r = await fetch('/api/scout/auto-status');
    var d = await r.json();
    var el = document.getElementById('auto-run-badge');
    if (!el) return;
    if (d.next_run_in_hours <= 0) {
      el.textContent = '\u23F0 Auto-run: due soon';
    } else {
      var h = d.next_run_in_hours;
      var label = h < 1 ? 'in ' + Math.round(h * 60) + 'm' : 'in ' + Math.round(h) + 'h';
      el.textContent = '\u23F0 Next auto-run ' + label;
    }
    el.style.display = 'inline';
  } catch(e) { /* ignore */ }
}

// ── Outreach modal ──────────────────────────────────────────────────────────
async function openOutreach(jobId, title, company) {
  var modal = document.getElementById('outreach-modal');
  var titleEl = document.getElementById('outreach-title');
  var body = document.getElementById('outreach-body');
  titleEl.textContent = '\u2709 Reach out about ' + title + ' @ ' + company;
  body.innerHTML = '<div class="modal-spinner">Drafting with Claude\u2026</div>';
  modal.style.display = 'flex';
  try {
    var res = await fetch('/api/jobs/' + jobId + '/outreach', { method: 'POST' });
    if (!res.ok) { throw new Error('Failed'); }
    var d = await res.json();
    var connLen = (d.connection_request || '').length;
    body.innerHTML =
      '<div class="modal-section">' +
        '<div class="modal-label">\uD83D\uDD17 LinkedIn Connection Request (' + connLen + '/300 chars)</div>' +
        '<div class="modal-text" id="outreach-conn">' + esc(d.connection_request || '') + '</div>' +
        '<div class="modal-char-count">' + connLen + ' characters</div>' +
        '<button class="btn btn-ghost btn-sm modal-copy-btn" onclick="copyConn(this)">\uD83D\uDCCB Copy</button>' +
      '</div>' +
      '<div class="modal-section">' +
        '<div class="modal-label">\uD83D\uDCAC LinkedIn DM (after connecting)</div>' +
        '<div class="modal-text" id="outreach-dm">' + esc(d.linkedin_dm || '') + '</div>' +
        '<button class="btn btn-ghost btn-sm modal-copy-btn" onclick="copyDm(this)">\uD83D\uDCCB Copy</button>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--muted);margin-top:4px">Tip: search LinkedIn for a recruiter or hiring manager at ' + esc(company) + ' before sending.</div>';
  } catch(e) {
    body.innerHTML = '<div style="color:var(--red);padding:16px">Failed to generate outreach. Please try again.</div>';
  }
}

function closeOutreach() {
  document.getElementById('outreach-modal').style.display = 'none';
}

function copyOutreach(elId, btn) {
  var text = document.getElementById(elId).textContent;
  navigator.clipboard.writeText(text).then(function() {
    btn.textContent = '\u2713 Copied!';
    setTimeout(function() { btn.textContent = '\uD83D\uDCCB Copy'; }, 2000);
  }).catch(function() {
    btn.textContent = 'Select & copy manually';
  });
}
function copyConn(btn) { copyOutreach('outreach-conn', btn); }
function copyDm(btn)   { copyOutreach('outreach-dm', btn); }

// ── Cover Letter Modal ──────────────────────────────────────────────────────
var _clJobId = null;
var _clJobTitle = '';
var _clCompany = '';

function clEl(id) { return document.getElementById(id); }

async function openCoverLetter(jobId, title, company) {
  _clJobId = jobId;
  _clJobTitle = title;
  _clCompany = company;

  clEl('cl-modal-title').textContent = 'Cover Letter \u2014 ' + title + ' at ' + company;
  clEl('cl-modal-ts').textContent = '';
  clEl('cl-model-badge').style.display = 'none';
  clEl('cl-cached-badge').style.display = 'none';
  clEl('cl-regen-btn').style.display = 'none';
  clEl('cl-loading').style.display = '';
  clEl('cl-error').style.display = 'none';
  clEl('cl-content').style.display = 'none';
  clEl('cl-footer').style.display = 'none';
  clEl('cl-modal').style.display = 'flex';

  // Set model-aware loading text
  try {
    var mr = await fetch('/api/settings/document_model');
    var md = await mr.json();
    var m = md.value || 'claude-opus-4-6';
    setClLoadingText(m);
  } catch(e) { setClLoadingText('claude-opus-4-6'); }

  fetchCoverLetter(false);
}

function setClLoadingText(model) {
  var msgEl = clEl('cl-loading-msg');
  var subEl = clEl('cl-loading-sub');
  var isOpus = model.includes('opus');
  if (msgEl) msgEl.textContent = isOpus ? 'Writing with Opus \u2014 this produces the best results\u2026' : 'Writing with Sonnet\u2026';
  if (subEl) subEl.textContent = isOpus ? 'Step 1: researching company \u2014 Step 2: writing your letter \u2014 45\u201390 seconds' : 'Step 1: researching company \u2014 Step 2: writing your letter \u2014 20\u201340 seconds';
}

function closeCoverLetterModal() {
  clEl('cl-modal').style.display = 'none';
}

function goToResumeTabCl() { showTab('resume'); closeCoverLetterModal(); }

async function regenerateCoverLetter() {
  if (!_clJobId) return;
  clEl('cl-loading').style.display = '';
  clEl('cl-error').style.display = 'none';
  clEl('cl-content').style.display = 'none';
  clEl('cl-footer').style.display = 'none';
  clEl('cl-cached-badge').style.display = 'none';
  clEl('cl-regen-btn').style.display = 'none';
  clEl('cl-model-badge').style.display = 'none';
  try {
    var mr = await fetch('/api/settings/document_model');
    var md = await mr.json();
    setClLoadingText(md.value || 'claude-opus-4-6');
  } catch(e) { setClLoadingText('claude-opus-4-6'); }
  fetchCoverLetter(true);
}

async function fetchCoverLetter(force) {
  try {
    var url = '/api/jobs/' + _clJobId + '/cover-letter' + (force ? '?force=true' : '');
    var res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    var json = await res.json();

    if (!res.ok) {
      if (json.error === 'NO_RESUME') {
        showClError(json.message + ' <a href="#" onclick="goToResumeTabCl();return false" style="color:var(--gold)">Go to Resume page</a>');
      } else {
        showClError(json.error || 'Failed to generate cover letter');
      }
      return;
    }

    renderCoverLetter(json);
  } catch(e) {
    showClError('Network error: ' + e.message);
  }
}

function modelLabel(model) {
  if (!model) return '';
  if (model.includes('opus')) return 'Generated with Opus';
  if (model.includes('sonnet')) return 'Generated with Sonnet';
  return 'Generated with ' + model;
}

function renderCoverLetter(data) {
  var letter = data.cover_letter || '';
  clEl('cl-letter-text').textContent = letter;

  var ts = data.created_at ? new Date(data.created_at).toLocaleString() : '';
  clEl('cl-modal-ts').textContent = ts ? ts : '';
  var badge = clEl('cl-model-badge');
  if (badge && data.model) { badge.textContent = modelLabel(data.model); badge.style.display = ''; }
  else if (badge) badge.style.display = 'none';
  clEl('cl-cached-badge').style.display = data.cached ? '' : 'none';
  clEl('cl-regen-btn').style.display = '';

  var research = data.research;
  if (research && research.specificFacts && research.specificFacts.length > 0) {
    var listEl = clEl('cl-research-list');
    listEl.innerHTML = '<ul style="list-style:disc;padding-left:16px;margin:0">' +
      research.specificFacts.map(function(f) { return '<li>' + esc(f) + '</li>'; }).join('') +
      (research.companyMoment ? '<li><strong>Company moment:</strong> ' + esc(research.companyMoment) + '</li>' : '') +
    '</ul>';
    clEl('cl-research-section').style.display = '';
  } else {
    clEl('cl-research-section').style.display = 'none';
  }

  clEl('cl-loading').style.display = 'none';
  clEl('cl-error').style.display = 'none';
  clEl('cl-content').style.display = '';
  clEl('cl-footer').style.display = '';
}

function showClError(msg) {
  clEl('cl-loading').style.display = 'none';
  var errMsg = clEl('cl-error-msg');
  errMsg.innerHTML = msg;
  clEl('cl-error').style.display = '';
  clEl('cl-regen-btn').style.display = '';
}

var _clResearchOpen = false;
function toggleClResearch() {
  _clResearchOpen = !_clResearchOpen;
  var list = clEl('cl-research-list');
  var toggle = clEl('cl-research-toggle');
  list.classList.toggle('open', _clResearchOpen);
  if (toggle) toggle.textContent = _clResearchOpen ? '\u25BC' : '\u25B6';
}

function copyCoverLetter() {
  var txt = clEl('cl-letter-text').textContent || '';
  if (!txt.trim()) return;
  navigator.clipboard.writeText(txt).then(function() {
    var btn = clEl('cl-modal').querySelector('button[onclick="copyCoverLetter()"]');
    if (btn) { var orig = btn.textContent; btn.textContent = '\u2713 Copied!'; setTimeout(function() { btn.textContent = orig; }, 1800); }
  }).catch(function() {
    var ta = document.createElement('textarea');
    ta.value = txt; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
  });
}

function downloadCoverLetter() {
  var txt = clEl('cl-letter-text').textContent || '';
  if (!txt.trim()) return;
  var date = new Date().toISOString().slice(0, 10);
  var safeCo = (_clCompany || 'Company').replace(/[^a-zA-Z0-9]/g, '_');
  var filename = 'CoverLetter_' + safeCo + '_' + date + '.txt';
  var blob = new Blob([txt], { type: 'text/plain' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── settings / criteria ────────────────────────────────────────────────────
var _criteriaTagState = {};
function initTagInput(inputId, tagsId, stateKey) {
  _criteriaTagState[stateKey] = _criteriaTagState[stateKey] || [];
  var input = document.getElementById(inputId);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var val = input.value.trim();
      if (val && _criteriaTagState[stateKey].indexOf(val) === -1) {
        _criteriaTagState[stateKey].push(val);
        renderTags(tagsId, stateKey);
      }
      input.value = '';
    }
  });
}
function renderTags(tagsId, stateKey) {
  var el = document.getElementById(tagsId);
  el.innerHTML = _criteriaTagState[stateKey].map(function(t, i) {
    return '<span class="tag">' + esc(t) + ' <span class="x" data-key="' + stateKey + '" data-idx="' + i + '" data-tags="' + tagsId + '">&times;</span></span>';
  }).join('');
  el.querySelectorAll('.x').forEach(function(btn) {
    btn.onclick = function() {
      var key = btn.getAttribute('data-key');
      var idx = Number(btn.getAttribute('data-idx'));
      var tid = btn.getAttribute('data-tags');
      _criteriaTagState[key].splice(idx, 1);
      renderTags(tid, key);
    };
  });
}
function setTags(stateKey, tagsId, arr) {
  _criteriaTagState[stateKey] = arr || [];
  renderTags(tagsId, stateKey);
}

var _criteriaInitialized = false;
async function setDocumentModel(model) {
  await fetch('/api/settings/document_model', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({value:model}) });
  var msg = document.getElementById('document-model-msg');
  if (msg) { msg.style.display = ''; setTimeout(function(){ msg.style.display = 'none'; }, 2000); }
}

function toggleFundingStages() {
  var isPrivate = document.getElementById('co-type-private');
  var row = document.getElementById('funding-stage-row');
  if (row) row.style.display = (isPrivate && isPrivate.checked) ? '' : 'none';
}

async function loadCriteria() {
  try {
    var c;
    // On first call: use server-injected data (already in the page, no round-trip, no flash)
    // On subsequent calls: re-fetch from API to pick up any changes
    if (!_criteriaInitialized && window.__initialCriteria__) {
      c = window.__initialCriteria__;
    } else {
      var res = await fetch('/api/criteria');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      c = await res.json();
    }
    document.getElementById('set-salary').value = c.min_salary || '';
    document.getElementById('set-ote').value = c.min_ote || '';
    document.getElementById('set-name').value = c.your_name || '';
    document.getElementById('set-email').value = c.your_email || '';
    document.getElementById('set-proxy-url').value = c.proxy_url || '';
    // Work mode checkboxes
    var modes = c.allowed_work_modes || ['remote_us'];
    document.getElementById('mode-remote-us').checked = modes.includes('remote_us');
    document.getElementById('mode-territory').checked = modes.includes('remote_in_territory');
    document.getElementById('mode-onsite').checked = modes.includes('onsite');
    // Experience level checkboxes (multi-select) — 4-tier model
    var expLevels = c.experience_levels || ['senior'];
    ['junior','mid','senior','strategic'].forEach(function(lvl) {
      var el = document.getElementById('exp-' + lvl);
      if (el) el.checked = expLevels.includes(lvl);
    });
    // Tier scoring sliders
    var topScore = c.top_target_score || 65;
    var fastScore = c.fast_win_score || 55;
    var stretchScore = c.stretch_score || 55;
    document.getElementById('set-top-score').value = topScore;
    document.getElementById('set-top-score-val').textContent = topScore;
    document.getElementById('set-fast-score').value = fastScore;
    document.getElementById('set-fast-score-val').textContent = fastScore;
    document.getElementById('set-stretch-score').value = stretchScore;
    document.getElementById('set-stretch-score-val').textContent = stretchScore;
    setTags('locations', 'set-loc-tags', c.locations);
    setTags('roles', 'set-roles-tags', c.target_roles);
    setTags('industries', 'set-ind-tags', c.industries);
    setTags('must_have', 'set-must-tags', c.must_have);
    setTags('nice_to_have', 'set-nice-tags', c.nice_to_have);
    setTags('avoid', 'set-avoid-tags', c.avoid);
    // Default vertical niches if none saved
    var defaultNiches = ['federal','government','SLED','FSI','DOD','defense','public sector','healthcare','pharma','banking','financial services'];
    setTags('vertical_niches', 'set-niches-tags', (c.vertical_niches && c.vertical_niches.length > 0) ? c.vertical_niches : defaultNiches);
    // Company type checkboxes
    document.getElementById('co-type-public').checked  = c.company_public  !== false;
    document.getElementById('co-type-private').checked = c.company_private !== false;
    toggleFundingStages();
    // Funding stage chips
    var fundingStages = c.company_funding_stages || [];
    ['series-a','series-b','series-c','series-d','bootstrapped','pe-backed'].forEach(function(s) {
      var el = document.getElementById('fs-' + s);
      if (el) el.checked = fundingStages.includes(s);
    });
    // Revenue band chips
    var revBands = c.company_revenue_bands || [];
    ['0-25m','25-50m','50-100m','100-500m','500m-1b','1b-10b','10b-plus'].forEach(function(b) {
      var el = document.getElementById('rev-' + b);
      if (el) el.checked = revBands.includes(b);
    });
    // Employee count chips
    var empBands = c.company_employee_bands || [];
    ['1-10','10-100','100-500','500-1k','1k-10k','10k-plus'].forEach(function(b) {
      var el = document.getElementById('emp-' + b);
      if (el) el.checked = empBands.includes(b);
    });
    if (!_criteriaInitialized) {
      initTagInput('set-loc-input', 'set-loc-tags', 'locations');
      initTagInput('set-roles-input', 'set-roles-tags', 'roles');
      initTagInput('set-ind-input', 'set-ind-tags', 'industries');
      initTagInput('set-must-input', 'set-must-tags', 'must_have');
      initTagInput('set-nice-input', 'set-nice-tags', 'nice_to_have');
      initTagInput('set-avoid-input', 'set-avoid-tags', 'avoid');
      initTagInput('set-niches-input', 'set-niches-tags', 'vertical_niches');
      _criteriaInitialized = true;
    }
    // Load saved document model and set the dropdown
    try {
      var dmr = await fetch('/api/settings/document_model');
      var dmd = await dmr.json();
      var savedDocModel = dmd.value || 'claude-opus-4-6';
      var sel = document.getElementById('document-model-select');
      if (sel) sel.value = savedDocModel;
    } catch(e2) {
      var sel2 = document.getElementById('document-model-select');
      if (sel2) sel2.value = 'claude-opus-4-6';
    }
  } catch(e) {
    console.error('loadCriteria failed:', e);
  }
}
async function saveCriteria() {
  // Collect work modes from checkboxes
  var workModes = [];
  if (document.getElementById('mode-remote-us').checked) workModes.push('remote_us');
  if (document.getElementById('mode-territory').checked) workModes.push('remote_in_territory');
  if (document.getElementById('mode-onsite').checked) workModes.push('onsite');
  // Collect experience levels from checkboxes — 4-tier model
  var expLevels = [];
  ['junior','mid','senior','strategic'].forEach(function(lvl) {
    var el = document.getElementById('exp-' + lvl);
    if (el && el.checked) expLevels.push(lvl);
  });
  if (expLevels.length === 0) expLevels = ['senior'];
  // Collect company type
  var coPublic  = document.getElementById('co-type-public').checked;
  var coPrivate = document.getElementById('co-type-private').checked;
  // Collect funding stages (only relevant when private is checked)
  var fundingStages = [];
  ['series-a','series-b','series-c','series-d','bootstrapped','pe-backed'].forEach(function(s) {
    var el = document.getElementById('fs-' + s);
    if (el && el.checked) fundingStages.push(s);
  });
  // Collect revenue bands
  var revBands = [];
  ['0-25m','25-50m','50-100m','100-500m','500m-1b','1b-10b','10b-plus'].forEach(function(b) {
    var el = document.getElementById('rev-' + b);
    if (el && el.checked) revBands.push(b);
  });
  // Collect employee bands
  var empBands = [];
  ['1-10','10-100','100-500','500-1k','1k-10k','10k-plus'].forEach(function(b) {
    var el = document.getElementById('emp-' + b);
    if (el && el.checked) empBands.push(b);
  });
  var body = {
    min_salary: Number(document.getElementById('set-salary').value) || null,
    min_ote: Number(document.getElementById('set-ote').value) || null,
    allowed_work_modes: workModes,
    experience_levels: expLevels,
    your_name: document.getElementById('set-name').value.trim(),
    your_email: document.getElementById('set-email').value.trim(),
    top_target_score: Number(document.getElementById('set-top-score').value) || 65,
    fast_win_score: Number(document.getElementById('set-fast-score').value) || 55,
    stretch_score: Number(document.getElementById('set-stretch-score').value) || 55,
    locations: _criteriaTagState.locations || [],
    target_roles: _criteriaTagState.roles || [],
    industries: _criteriaTagState.industries || [],
    must_have: _criteriaTagState.must_have || [],
    nice_to_have: _criteriaTagState.nice_to_have || [],
    avoid: _criteriaTagState.avoid || [],
    vertical_niches: _criteriaTagState.vertical_niches || [],
    proxy_url: (document.getElementById('set-proxy-url').value || '').trim(),
    company_public: coPublic,
    company_private: coPrivate,
    company_funding_stages: fundingStages,
    company_revenue_bands: revBands,
    company_employee_bands: empBands
  };
  try {
    var res = await fetch('/api/criteria', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var msg = document.getElementById('settings-msg');
    msg.style.display = 'inline';
    msg.textContent = 'Saved!';
    setTimeout(function() { msg.style.display = 'none'; }, 2500);
  } catch(e) {
    console.error('saveCriteria failed:', e);
    alert('Failed to save settings: ' + e.message);
  }
}

// ── research company ────────────────────────────────────────────────────
var _researchBrief = null;
var _researchJobId = null;
var _researchBriefId = null;
var _researchBriefSaved = false;
var _researchTimer = null;
var _researchStart = 0;

function closeResearchModal() {
  document.getElementById('research-modal').classList.remove('show');
  if (_researchTimer) { clearInterval(_researchTimer); _researchTimer = null; }
}

function showResearchTab(tab) {
  var tabs = document.getElementById('research-tabs').children;
  var tabNames = ['interview','overview','market','sales','news','scorecard'];
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle('active', tabNames[i] === tab);
  }
  renderResearchTab(tab);
}

function renderResearchTab(tab) {
  var b = _researchBrief;
  if (!b) return;
  var body = document.getElementById('research-body');
  var html = '';
  if (tab === 'interview') {
    html += '<h4>Talking Points for Interview / Discovery Call</h4>';
    html += '<ol>';
    (b.talkingPoints || []).forEach(function(tp) { html += '<li>' + esc(tp) + '</li>'; });
    html += '</ol>';
  } else if (tab === 'overview') {
    html += '<h4>Company Overview</h4>';
    html += '<p>' + esc(b.overview || '').replace(/\\n/g, '</p><p>') + '</p>';
    html += '<h4>What They Solve</h4>';
    html += '<p>' + esc(b.whatTheySolve || '') + '</p>';
    html += '<h4>Key Products</h4>';
    html += '<div class="research-tags">';
    (b.keyProducts || []).forEach(function(p) { html += '<span class="research-tag">' + esc(p) + '</span>'; });
    html += '</div>';
  } else if (tab === 'market') {
    html += '<h4>AI Strategy</h4>';
    html += '<p>' + esc(b.aiStrategy || '') + '</p>';
    html += '<h4>Competitive Advantage</h4>';
    html += '<p>' + esc(b.competitiveAdvantage || '') + '</p>';
    html += '<h4>Competitors</h4>';
    html += '<div class="research-tags">';
    (b.competitors || []).forEach(function(c) { html += '<span class="research-tag">' + esc(c) + '</span>'; });
    html += '</div>';
  } else if (tab === 'sales') {
    html += '<h4>Sales Motion</h4>';
    html += '<p>' + esc(b.salesMotion || '') + '</p>';
    html += '<h4>Why Apply</h4>';
    html += '<p>' + esc(b.whyApply || '') + '</p>';
    html += '<h4>Key Executives</h4>';
    html += '<ul>';
    (b.keyExecutives || []).forEach(function(e) { html += '<li>' + esc(e) + '</li>'; });
    html += '</ul>';
  } else if (tab === 'news') {
    html += '<h4>Recent News</h4>';
    html += '<ul>';
    (b.recentNews || []).forEach(function(n) { html += '<li>' + esc(n) + '</li>'; });
    html += '</ul>';
  } else if (tab === 'scorecard') {
    var j = _jobsById[_researchJobId] || {};
    var sc = computeScorecard(j);
    var overallColor = sc.overall_score >= 80 ? '#00c86e' : sc.overall_score >= 65 ? '#f5c842' : sc.overall_score >= 45 ? '#ff9f43' : '#e55353';
    var tierIcon = sc.tier === 'Top Target' ? '\uD83C\uDFAF' : sc.tier === 'Fast Win' ? '\u26A1' : sc.tier === 'Stretch Role' ? '\uD83D\uDE80' : '\uD83D\uDEAB';
    var recCol = sc.recommended_action === 'Apply Now' ? '#00c86e' : sc.recommended_action === 'Tailor Resume First' ? '#f5c842' : sc.recommended_action === 'Low Priority' ? '#555' : '#7c8dff';

    // Overall header
    html += '<div class="sc-overall">';
    html +=   '<div class="sc-overall-score" style="color:' + overallColor + '">' + sc.overall_score + '</div>';
    html +=   '<div class="sc-overall-right">';
    html +=     '<div class="sc-overall-tier" style="color:' + overallColor + '">' + tierIcon + ' ' + esc(sc.tier || 'Unscored') + '</div>';
    html +=     '<div class="sc-overall-rec">Recommended: <span class="sc-rec-chip" style="background:' + recCol + '22;color:' + recCol + '">\u2192 ' + esc(sc.recommended_action) + '</span></div>';
    html +=   '</div>';
    html += '</div>';

    // 9 dimension bars
    var dimData = [
      ['Fit to Settings',    sc.fit_to_user_settings,     'Role title, location, comp, territory match to your preferences'],
      ['Resume Fit',         sc.fit_to_resume_background, 'How well this role aligns with your background and experience level'],
      ['Source Quality',     sc.source_confidence,        'Trust level of where this job was sourced from (ATS direct vs aggregator)'],
      ['Link Confidence',    sc.canonical_link_confidence,'Confidence the displayed URL leads to the real active posting'],
      ['Company Quality',    sc.company_attractiveness,   'Company momentum, funding signals, growth trajectory'],
      ['Hiring Urgency',     sc.likely_hiring_urgency,    'How fresh and time-sensitive this posting appears to be'],
      ['Outreach Path',      sc.ease_of_outreach_path,    'How reachable the hiring team or manager is likely to be'],
      ['Career Upside',      sc.career_upside,            'Strategic value for your career growth and resume trajectory'],
    ];
    if (sc.comp_quality !== null) {
      dimData.splice(4, 0, ['Comp Quality', sc.comp_quality, 'How attractive and explicit the compensation is relative to your targets']);
    }

    html += '<div class="sc-section-label">Score Breakdown</div>';
    html += '<div class="sc-dim-grid">';
    for (var di = 0; di < dimData.length; di++) {
      var dname = dimData[di][0];
      var dval  = dimData[di][1];
      var ddesc = dimData[di][2];
      var dcol  = scColor(dval);
      html += '<div class="sc-dim-row">';
      html +=   '<div class="sc-dim-header"><span class="sc-dim-label">' + esc(dname) + '</span><span class="sc-dim-score-val" style="color:' + dcol + '">' + dval + '</span></div>';
      html +=   '<div class="sc-dim-bar-bg"><div class="sc-dim-bar-fill" style="width:' + dval + '%;background:' + dcol + '"></div></div>';
      html +=   '<div class="sc-dim-desc">' + esc(ddesc) + '</div>';
      html += '</div>';
    }
    html += '</div>';

    // Strengths
    if (sc.strengths.length > 0) {
      html += '<div class="sc-section-label">Key Strengths</div>';
      for (var si = 0; si < sc.strengths.length; si++) {
        html += '<div class="sc-list-item strength">' + esc(sc.strengths[si]) + '</div>';
      }
    }

    // Risks
    if (sc.risks.length > 0) {
      html += '<div class="sc-section-label">Risks &amp; Cautions</div>';
      for (var ri = 0; ri < sc.risks.length; ri++) {
        html += '<div class="sc-list-item risk">' + esc(sc.risks[ri]) + '</div>';
      }
    }

    // Why this ranking
    html += '<div class="sc-section-label">Why It Ranks Here</div>';
    html += '<p style="font-size:12px;color:#888;line-height:1.6">';
    html += 'Ranked <strong style="color:' + overallColor + '">' + sc.overall_score + '/100</strong> based on a weighted combination of role fit, company quality, and source confidence. ';
    if (sc.tier === 'Top Target')  html += 'Top Target status means strong role match, quality company, and accessible seniority level.';
    else if (sc.tier === 'Fast Win') html += 'Fast Win status means a solid score with achievable profile match — a realistic near-term opportunity.';
    else if (sc.tier === 'Stretch Role') html += 'Stretch Role means above your current level or niche — worth pursuing selectively or via networking.';
    else html += 'Probably Skip — score does not meet threshold for active pursuit at this time.';
    if (j.why_good_fit) { html += ' ' + esc(j.why_good_fit); }
    html += '</p>';
  }
  body.innerHTML = html;
}

function updateSaveBtn() {
  var btn = document.getElementById('research-save-btn');
  if (_researchBriefSaved) {
    btn.textContent = 'Saved \\u2713';
    btn.className = 'btn btn-ghost btn-sm';
    btn.disabled = true;
  } else {
    btn.textContent = 'Save Brief';
    btn.className = 'btn btn-gold btn-sm';
    btn.disabled = false;
  }
}

function displayResearchBrief(data) {
  var b = typeof data.brief === 'string' ? JSON.parse(data.brief) : data.brief;
  _researchBrief = b;
  _researchBriefId = data.id || null;
  _researchBriefSaved = !!data.saved;
  document.getElementById('research-loading').style.display = 'none';
  document.getElementById('research-error').style.display = 'none';
  document.getElementById('research-content').style.display = '';
  document.getElementById('research-company-name').textContent = b.companyName || '';
  document.getElementById('research-oneliner').textContent = b.oneLiner || '';
  document.getElementById('research-funding').textContent = b.fundingValuation || 'N/A';
  document.getElementById('research-revenue').textContent = b.revenueGrowth || 'N/A';
  updateSaveBtn();

  var genAt = b.generatedAt || data.created_at;
  var ago = '';
  if (genAt) {
    var diffMs = Date.now() - new Date(genAt).getTime();
    var mins = Math.floor(diffMs / 60000);
    if (mins < 1) ago = 'just now';
    else if (mins < 60) ago = mins + ' minute' + (mins !== 1 ? 's' : '') + ' ago';
    else { var hrs = Math.floor(mins / 60); ago = hrs + ' hour' + (hrs !== 1 ? 's' : '') + ' ago'; }
  }
  document.getElementById('research-meta').innerHTML = 'Generated ' + esc(ago) + ' \\u00B7 <a onclick="refreshResearch()">Refresh</a>';

  var j = _jobsById[_researchJobId] || {};
  var careersLink = document.getElementById('research-careers-link');
  if (data.careers_url) {
    careersLink.href = data.careers_url;
  } else {
    careersLink.href = 'https://www.google.com/search?q=' + encodeURIComponent(j.company + ' careers jobs');
  }

  showResearchTab('interview');
}

async function _safeFetchJson(url, opts) {
  var res = await fetch(url, opts);
  var text = await res.text();
  if (!text || !text.trim()) throw new Error('Empty response from server — retrying...');
  try {
    var json = JSON.parse(text);
  } catch(e) {
    if (text.includes('<!DOCTYPE') || text.includes('<html')) {
      throw new Error('Server proxy timeout — still working, retrying...');
    }
    throw new Error('Invalid response: ' + text.substring(0, 100));
  }
  if (!res.ok) throw new Error(json.error || 'HTTP ' + res.status);
  return json;
}

async function _pollResearch(briefId) {
  var maxAttempts = 150; // poll for up to ~5 minutes
  var consecutiveErrors = 0;
  for (var i = 0; i < maxAttempts; i++) {
    await new Promise(function(r) { setTimeout(r, 2000); });
    try {
      var pollData = await _safeFetchJson('/api/research/status/' + briefId);
      consecutiveErrors = 0;
      if (pollData.status === 'ready') return pollData;
      if (pollData.status === 'error') throw new Error(pollData.error || 'Research failed');
    } catch(e) {
      consecutiveErrors++;
      if (e.message === 'Research failed' || e.message.startsWith('Failed to parse')) throw e;
      if (consecutiveErrors > 5) throw new Error('Lost connection to server — please try again');
      // Otherwise keep polling (transient proxy/network error)
    }
  }
  throw new Error('Research is taking too long — please try again');
}

async function researchCompany(jobId) {
  _researchJobId = jobId;
  var j = _jobsById[jobId] || {};
  var btn = document.getElementById('research-btn-' + jobId);
  if (btn) { btn.textContent = 'Researching...'; btn.disabled = true; }

  var modal = document.getElementById('research-modal');
  document.getElementById('research-loading').style.display = '';
  document.getElementById('research-error').style.display = 'none';
  document.getElementById('research-content').style.display = 'none';
  modal.classList.add('show');

  _researchStart = Date.now();
  if (_researchTimer) clearInterval(_researchTimer);
  _researchTimer = setInterval(function() {
    var secs = Math.floor((Date.now() - _researchStart) / 1000);
    var el = document.getElementById('research-elapsed');
    if (el) el.textContent = secs + 's elapsed';
  }, 1000);

  try {
    // Try initial POST up to 3 times (Replit proxy can be flaky)
    var data;
    var lastErr;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        data = await _safeFetchJson('/api/jobs/' + jobId + '/research', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({})
        });
        break;
      } catch(e) {
        lastErr = e;
        if (attempt < 2) await new Promise(function(r) { setTimeout(r, 1000); });
      }
    }
    if (!data) throw lastErr;
    if (data.status === 'processing') {
      data = await _pollResearch(data.id);
    }
    if (_researchTimer) { clearInterval(_researchTimer); _researchTimer = null; }
    displayResearchBrief(data);
  } catch(e) {
    if (_researchTimer) { clearInterval(_researchTimer); _researchTimer = null; }
    document.getElementById('research-loading').style.display = 'none';
    document.getElementById('research-error').style.display = '';
    document.getElementById('research-error-msg').textContent = 'Error: ' + e.message;
  } finally {
    if (btn) { btn.textContent = '\\uD83D\\uDD0D Research Company'; btn.disabled = false; }
  }
}

async function refreshResearch() {
  if (!_researchJobId) return;
  document.getElementById('research-loading').style.display = '';
  document.getElementById('research-error').style.display = 'none';
  document.getElementById('research-content').style.display = 'none';

  _researchStart = Date.now();
  if (_researchTimer) clearInterval(_researchTimer);
  _researchTimer = setInterval(function() {
    var secs = Math.floor((Date.now() - _researchStart) / 1000);
    var el = document.getElementById('research-elapsed');
    if (el) el.textContent = secs + 's elapsed';
  }, 1000);

  try {
    var data;
    var lastErr;
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        data = await _safeFetchJson('/api/jobs/' + _researchJobId + '/research', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({ refresh: true })
        });
        break;
      } catch(e) {
        lastErr = e;
        if (attempt < 2) await new Promise(function(r) { setTimeout(r, 1000); });
      }
    }
    if (!data) throw lastErr;
    if (data.status === 'processing') {
      data = await _pollResearch(data.id);
    }
    if (_researchTimer) { clearInterval(_researchTimer); _researchTimer = null; }
    displayResearchBrief(data);
  } catch(e) {
    if (_researchTimer) { clearInterval(_researchTimer); _researchTimer = null; }
    document.getElementById('research-loading').style.display = 'none';
    document.getElementById('research-error').style.display = '';
    document.getElementById('research-error-msg').textContent = 'Error: ' + e.message;
  }
}

function retryResearch() {
  if (_researchJobId) researchCompany(_researchJobId);
}

function copyFullBrief() {
  var b = _researchBrief;
  if (!b) return;
  var text = b.companyName + '\\n' + (b.oneLiner || '') + '\\n\\n';
  text += 'OVERVIEW\\n' + (b.overview || '') + '\\n\\n';
  text += 'WHAT THEY SOLVE\\n' + (b.whatTheySolve || '') + '\\n\\n';
  text += 'KEY PRODUCTS\\n' + (b.keyProducts || []).join(', ') + '\\n\\n';
  text += 'AI STRATEGY\\n' + (b.aiStrategy || '') + '\\n\\n';
  text += 'COMPETITIVE ADVANTAGE\\n' + (b.competitiveAdvantage || '') + '\\n\\n';
  text += 'COMPETITORS\\n' + (b.competitors || []).join(', ') + '\\n\\n';
  text += 'SALES MOTION\\n' + (b.salesMotion || '') + '\\n\\n';
  text += 'WHY APPLY\\n' + (b.whyApply || '') + '\\n\\n';
  text += 'KEY EXECUTIVES\\n' + (b.keyExecutives || []).join(', ') + '\\n\\n';
  text += 'FUNDING / VALUATION\\n' + (b.fundingValuation || '') + '\\n\\n';
  text += 'REVENUE / GROWTH\\n' + (b.revenueGrowth || '') + '\\n\\n';
  text += 'TALKING POINTS\\n' + (b.talkingPoints || []).map(function(tp, i) { return (i + 1) + '. ' + tp; }).join('\\n') + '\\n\\n';
  text += 'RECENT NEWS\\n' + (b.recentNews || []).map(function(n) { return '- ' + n; }).join('\\n');
  navigator.clipboard.writeText(text);
}

// ── save research brief ──────────────────────────────────────────────────
async function saveResearchBrief() {
  if (!_researchBriefId) return;
  try {
    var res = await fetch('/api/research/' + _researchBriefId + '/save', { method: 'POST' });
    if (res.ok) {
      _researchBriefSaved = true;
      updateSaveBtn();
    }
  } catch(e) {}
}

// ── research page ────────────────────────────────────────────────────────
async function loadSavedResearch() {
  try {
    var res = await fetch('/api/research');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var briefs = await res.json();
    var grid = document.getElementById('research-grid');
    var cnt = document.getElementById('research-page-count');
    var empty = document.getElementById('research-empty');
    if (!briefs.length) {
      cnt.textContent = '';
      grid.innerHTML = '';
      empty.style.display = '';
      return;
    }
    empty.style.display = 'none';
    cnt.textContent = briefs.length + ' saved brief' + (briefs.length !== 1 ? 's' : '');
    grid.innerHTML = briefs.map(function(r) {
      var b = typeof r.brief_json === 'string' ? JSON.parse(r.brief_json) : r.brief_json;
      var age = '';
      if (r.created_at) {
        var diffMs = Date.now() - new Date(r.created_at).getTime();
        var mins = Math.floor(diffMs / 60000);
        if (mins < 60) age = mins + 'm ago';
        else { var hrs = Math.floor(mins / 60); if (hrs < 24) age = hrs + 'h ago'; else age = Math.floor(hrs / 24) + 'd ago'; }
      }
      return '<div class="card">' +
        '<div class="card-head">' +
          '<div class="job-title">' + esc(b.companyName || r.company_name) + '</div>' +
          '<div class="job-co" style="font-size:12px;color:var(--muted);margin-top:4px">' + esc(b.oneLiner || '') + '</div>' +
        '</div>' +
        '<div class="card-meta">' +
          '<span style="color:var(--gold)">' + esc(b.fundingValuation || '') + '</span>' +
          '<span>' + esc(b.revenueGrowth || '') + '</span>' +
          (age ? '<span class="age-badge">' + age + '</span>' : '') +
        '</div>' +
        '<div class="card-foot">' +
          '<button class="btn btn-gold btn-sm" onclick="viewSavedBrief(' + r.id + ')">View Brief</button>' +
          '<button class="btn btn-ghost btn-sm" onclick="deleteSavedBrief(' + r.id + ')">Delete</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch(e) {
    console.error('loadSavedResearch failed:', e);
    document.getElementById('research-page-count').textContent = 'Failed to load saved research';
  }
}

async function viewSavedBrief(briefId) {
  try {
    var res = await fetch('/api/research');
    var briefs = await res.json();
    var found = briefs.find(function(r) { return r.id === briefId; });
    if (!found) return;
    var modal = document.getElementById('research-modal');
    document.getElementById('research-loading').style.display = 'none';
    document.getElementById('research-error').style.display = 'none';
    document.getElementById('research-content').style.display = 'none';
    modal.classList.add('show');
    displayResearchBrief({ brief: found.brief_json, id: found.id, saved: found.saved, created_at: found.created_at, careers_url: null });
  } catch(e) {}
}

async function deleteSavedBrief(briefId) {
  try {
    await fetch('/api/research/' + briefId, { method: 'DELETE' });
    loadSavedResearch();
  } catch(e) {}
}

// ── Career Intel ──────────────────────────────────────────────────────────
var intelLoaded = false;
var _intelCompanies = [];

function intelEl(id) { return document.getElementById(id); }

function setIntelState(state) {
  intelEl('intel-loading').style.display  = state === 'loading'  ? 'flex' : 'none';
  intelEl('intel-empty').style.display    = state === 'empty'    ? ''     : 'none';
  intelEl('intel-error').style.display    = state === 'error'    ? ''     : 'none';
  intelEl('intel-content').style.display  = state === 'content'  ? ''     : 'none';
}

function actionBadge(action) {
  var labels = { target_now: 'Target Now', network_in: 'Network In', watch: 'Watch', low_priority: 'Low Priority' };
  var cls    = { target_now: 'intel-action-target', network_in: 'intel-action-network', watch: 'intel-action-watch', low_priority: 'intel-action-skip' };
  return '<span class="intel-action-badge ' + (cls[action] || 'intel-action-watch') + '">' + (labels[action] || action) + '</span>';
}

function renderCareerIntel(data, generatedAt, stale) {
  // Market summary
  if (data.market_summary) {
    intelEl('intel-market-summary').innerHTML = '<div class="intel-section-label">Market Summary</div><div class="intel-market-summary">' + esc(data.market_summary) + '</div>';
  }

  // Themes
  var themes = data.themes || [];
  if (themes.length > 0) {
    intelEl('intel-themes-section').style.display = '';
    intelEl('intel-themes').innerHTML = themes.map(function(t) {
      return '<div class="intel-theme-card">' +
        '<div class="intel-theme-name">' + esc(t.theme) + '</div>' +
        '<div class="intel-theme-body">' + esc(t.summary) + '</div>' +
        (t.why_it_matters_for_job_search ? '<div class="intel-theme-why">Why it matters: ' + esc(t.why_it_matters_for_job_search) + '</div>' : '') +
      '</div>';
    }).join('');
  } else {
    intelEl('intel-themes-section').style.display = 'none';
  }

  // Company count label
  var companies = data.companies || [];
  _intelCompanies = companies.map(function(c) { return c.company_name; }).filter(Boolean);
  intelEl('intel-companies-label').textContent = 'Company Opportunity Radar (' + companies.length + ' companies)';

  // Company cards
  intelEl('intel-cards').innerHTML = companies.map(function(c) {
    var conf = Math.round((c.confidence_score || 0) * 100);
    var confW = Math.min(100, conf);

    var citations = (c.source_citations || []).slice(0, 4).map(function(s) {
      return '<a class="intel-citation-link" href="' + esc(s.url) + '" target="_blank" rel="noopener">' + esc(s.title || s.url) + '</a>';
    }).join('');

    var roles = (c.likely_relevant_roles || []).map(function(r) {
      return '<span class="intel-role-chip">' + esc(r) + '</span>';
    }).join('');

    var riskHtml = '';
    if ((c.risk_flags || []).length > 0) {
      riskHtml = '<div class="intel-card-section">' +
        '<div class="intel-card-label">Risk Flags</div>' +
        '<div class="intel-risk-flags">' + c.risk_flags.map(function(f) { return '<div class="intel-risk-flag">' + esc(f) + '</div>'; }).join('') + '</div>' +
      '</div>';
    }

    var urlHtml = c.company_url
      ? '<a class="intel-company-url" href="' + esc(c.company_url) + '" target="_blank" rel="noopener">' + esc(c.company_url.replace(/^https?:\\/\\//, '')) + '</a>'
      : '';

    return '<div class="intel-card">' +
      '<div class="intel-card-header">' +
        '<div>' +
          '<div class="intel-company-name">' + esc(c.company_name) + '</div>' +
          urlHtml +
        '</div>' +
        actionBadge(c.action_recommendation) +
      '</div>' +

      '<div class="intel-card-divider"></div>' +

      '<div class="intel-card-section"><div class="intel-card-label">Why Hot Now</div><div class="intel-card-value">' + esc(c.why_it_is_hot_now) + '</div></div>' +
      '<div class="intel-card-section"><div class="intel-card-label">Good Place to Work</div><div class="intel-card-value">' + esc(c.why_it_could_be_a_good_place_to_work) + '</div></div>' +
      '<div class="intel-card-section"><div class="intel-card-label">Hiring Signal</div><div class="intel-card-value">' + esc(c.likely_hiring_signal) + '</div></div>' +
      '<div class="intel-card-section"><div class="intel-card-label">Fit to Your Settings</div><div class="intel-card-value">' + esc(c.fit_to_user_settings) + '</div></div>' +

      (roles ? '<div class="intel-card-section"><div class="intel-card-label">Likely Roles</div><div class="intel-roles-list">' + roles + '</div></div>' : '') +

      '<div class="intel-card-section"><div class="intel-card-label">Confidence</div>' +
        '<div class="intel-confidence">' +
          '<div class="intel-confidence-bar"><div class="intel-confidence-fill" style="width:' + confW + '%"></div></div>' +
          '<span class="intel-confidence-val">' + conf + '%</span>' +
        '</div>' +
      '</div>' +

      riskHtml +

      (citations ? '<div class="intel-card-section"><div class="intel-card-label">Sources</div><div class="intel-citations">' + citations + '</div></div>' : '') +

      '<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:2px">' +
        '<button class="save-watchlist-btn" onclick="saveToWatchlist(' + JSON.stringify(c.company_name) + ',' + JSON.stringify(c.company_url || '') + ',this)">\u2605 Save Company Profile</button>' +
      '</div>' +
    '</div>';
  }).join('');

  // Footer: last refreshed, model, stale notice
  var ts = generatedAt ? new Date(generatedAt).toLocaleString() : 'Unknown';
  var staleNotice = stale ? ' &nbsp;&middot;&nbsp; <span style="color:#f5c842">Data may be outdated &mdash; click Refresh Intel</span>' : '';
  var modelNote = data.model_used ? ' &nbsp;&middot;&nbsp; Model: ' + esc(data.model_used) : '';
  intelEl('intel-footer').innerHTML = 'Last refreshed: ' + ts + modelNote + ' &nbsp;&middot;&nbsp; ' + (data.grounding_sources_count || 0) + ' grounding sources' + staleNotice;

  // Update meta line
  intelEl('intel-meta').innerHTML = 'Powered by Gemini + Google Search grounding &mdash; refreshes daily';

  setIntelState('content');
}

async function loadCareerIntel() {
  if (intelLoaded) return;
  setIntelState('loading');
  try {
    var res = await fetch('/api/career-intel');
    var json = await res.json();
    if (!res.ok) { throw new Error(json.error || 'Failed to load Career Intel'); }
    if (!json.data) {
      setIntelState('empty');
      return;
    }
    intelLoaded = true;
    renderCareerIntel(json.data, json.generated_at, json.stale);
    if (json.stale) {
      // Auto-refresh if data is stale
      intelEl('intel-meta').innerHTML += ' &nbsp;<span style="color:#f5c842">(stale &mdash; refreshing&hellip;)</span>';
      refreshCareerIntel(true);
    }
  } catch(e) {
    intelEl('intel-error').textContent = 'Error loading Career Intel: ' + e.message;
    setIntelState('error');
  }
}

async function refreshCareerIntel(silent) {
  var btn = intelEl('intel-refresh-btn');
  if (!silent) setIntelState('loading');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing\u2026'; }
  try {
    var res = await fetch('/api/career-intel/refresh', { method: 'POST' });
    var json = await res.json();
    if (!res.ok) { throw new Error(json.error || 'Refresh failed'); }
    intelLoaded = true;
    renderCareerIntel(json.data, json.generated_at, false);
  } catch(e) {
    if (!silent) {
      intelEl('intel-error').textContent = 'Refresh failed: ' + e.message;
      setIntelState('error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Intel'; }
  }
}

// ── Pre-IPO Intelligence ──────────────────────────────────────────────────
var preIpoLoaded = false;
var preIpoAllCompanies = [];

function pEl(id) { return document.getElementById(id); }

function setPreIpoState(state) {
  ['loading','empty','error','content'].forEach(function(s) {
    pEl('preipo-' + s).style.display = s === state ? '' : 'none';
  });
}

async function loadPreIpo() {
  if (preIpoLoaded) return;
  setPreIpoState('loading');
  try {
    var res = await fetch('/api/preipo');
    var json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed to load Pre-IPO data');
    if (!json.data) { setPreIpoState('empty'); return; }
    preIpoLoaded = true;
    renderPreIpo(json.data, json.generated_at, json.stale);
    if (json.stale) {
      pEl('preipo-meta').innerHTML += ' &nbsp;<span style="color:#f5c842">(stale &mdash; refreshing&hellip;)</span>';
      refreshPreIpo(true);
    }
  } catch(e) {
    pEl('preipo-error').textContent = 'Error loading Pre-IPO data: ' + e.message;
    setPreIpoState('error');
  }
}

async function refreshPreIpo(silent) {
  var btn = pEl('preipo-refresh-btn');
  if (!silent) setPreIpoState('loading');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning\u2026'; }
  try {
    var res = await fetch('/api/preipo/refresh', { method: 'POST' });
    var json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Refresh failed');
    preIpoLoaded = true;
    renderPreIpo(json.data, json.generated_at, false);
  } catch(e) {
    if (!silent) {
      pEl('preipo-error').textContent = 'Refresh failed: ' + e.message;
      setPreIpoState('error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Radar'; }
  }
}

function renderPreIpo(data, generatedAt, stale) {
  preIpoAllCompanies = data.companies || [];

  // Thesis box
  if (data.series_b_thesis) pEl('preipo-thesis-text').textContent = data.series_b_thesis;

  // Market context
  if (data.market_context) pEl('preipo-market-ctx').textContent = data.market_context;

  // Meta line
  var dt = generatedAt ? new Date(generatedAt).toLocaleString() : '';
  var modelNote = data.model_used ? ' via ' + data.model_used : '';
  var srcNote = data.grounding_sources_count > 0 ? ' \u00B7 ' + data.grounding_sources_count + ' sources' : '';
  pEl('preipo-meta').textContent = 'Generated ' + dt + modelNote + srcNote + (stale ? ' \u00B7 stale' : '');

  // Render all companies, sorted by momentum
  filterPreIpo('all');
  setPreIpoState('content');

  // Stage counts for filter buttons
  var stageCounts = { all: preIpoAllCompanies.length };
  preIpoAllCompanies.forEach(function(c) {
    var s = c.funding_stage || 'Unknown';
    stageCounts[s] = (stageCounts[s] || 0) + 1;
  });
  document.querySelectorAll('.preipo-stage-btn').forEach(function(btn) {
    var stage = btn.getAttribute('data-stage');
    var count = stageCounts[stage] || 0;
    if (count > 0) btn.setAttribute('data-count', count);
  });

  // Footer
  pEl('preipo-footer').textContent = 'Data sourced via Gemini + Google Search grounding. Verify funding details independently before acting.';
}

function filterPreIpo(stage) {
  // Update active button
  document.querySelectorAll('.preipo-stage-btn').forEach(function(btn) {
    btn.classList.toggle('active', btn.getAttribute('data-stage') === stage);
  });

  var companies = stage === 'all'
    ? preIpoAllCompanies
    : preIpoAllCompanies.filter(function(c) { return c.funding_stage === stage; });

  var grid = pEl('preipo-grid');
  if (companies.length === 0) {
    grid.innerHTML = '<div class="preipo-empty" style="grid-column:1/-1">No companies found for this stage.</div>';
    return;
  }
  grid.innerHTML = companies.map(buildPreIpoCard).join('');
}

function buildPreIpoCard(c) {
  var isB = c.funding_stage === 'Series B';
  var stageClass = {
    'Series A': 'preipo-stage-a',
    'Series B': 'preipo-stage-b',
    'Series C': 'preipo-stage-c',
    'Series D+': 'preipo-stage-d'
  }[c.funding_stage] || 'preipo-stage-a';

  var actionClass = {
    'apply_now':    'preipo-action-now',
    'watch_closely':'preipo-action-watch',
    'network_in':   'preipo-action-network',
    'monitor':      'preipo-action-monitor'
  }[c.action] || 'preipo-action-monitor';
  var actionLabel = {
    'apply_now':    'Apply Now',
    'watch_closely':'Watch Closely',
    'network_in':   'Network In',
    'monitor':      'Monitor'
  }[c.action] || c.action;

  var score = c.momentum_score || 0;
  var scoreColor = score >= 90 ? '#00c86e' : score >= 75 ? '#f5c842' : score >= 60 ? '#7c8dff' : '#888';

  var signals = (c.hypergrowth_signals || []).slice(0, 4).map(function(s) {
    return '<div class="preipo-signal">' + s + '</div>';
  }).join('');

  var risks = (c.risk_flags || []).slice(0, 3).map(function(r) {
    return '<div class="preipo-risk">' + r + '</div>';
  }).join('');

  var roles = (c.likely_roles || []).slice(0, 4).map(function(r) {
    return '<span class="preipo-chip">' + r + '</span>';
  }).join('');

  var investors = (c.lead_investors || []).slice(0, 3).join(', ');

  var cites = (c.source_citations || []).slice(0, 2).map(function(s) {
    return '<a href="' + s.url + '" target="_blank" rel="noopener" class="preipo-cite">' + s.title + '</a>';
  }).join('');

  var urlHtml = c.company_url
    ? '<a href="' + c.company_url + '" target="_blank" rel="noopener" class="preipo-card-url">' + c.company_url.replace(/^https?:\\/\\//, '') + '</a>'
    : '';

  var fundingLine = [
    c.last_round_size,
    c.last_round_date ? ('&bull; ' + c.last_round_date) : '',
    investors ? ('&bull; ' + investors) : ''
  ].filter(Boolean).join(' ');

  var equityLine = c.equity_upside || '';
  var ipoLine = c.ipo_timeline_guess ? ('IPO: ' + c.ipo_timeline_guess) : '';

  return '<div class="preipo-card' + (isB ? ' is-seriesb' : '') + '">' +
    (isB ? '<div class="preipo-seriesb-label">&#x26A1; Hypergrowth</div>' : '') +
    '<div class="preipo-card-top">' +
      '<div>' +
        '<div class="preipo-card-name">' + c.company_name + '</div>' +
        (c.vertical ? '<div style="font-size:11px;color:var(--muted);margin-top:1px">' + c.vertical + (c.founded_year ? ' &bull; Founded ' + c.founded_year : '') + '</div>' : '') +
        urlHtml +
      '</div>' +
      '<div class="preipo-card-badges">' +
        '<span class="preipo-stage-badge ' + stageClass + '">' + (c.funding_stage || 'Unknown') + '</span>' +
        '<span class="preipo-action-badge ' + actionClass + '">' + actionLabel + '</span>' +
      '</div>' +
    '</div>' +

    '<div class="preipo-momentum">' +
      '<span class="preipo-lbl" style="white-space:nowrap;width:70px">Momentum</span>' +
      '<div class="preipo-momentum-bar"><div class="preipo-momentum-fill" style="width:' + score + '%;background:' + scoreColor + '"></div></div>' +
      '<span class="preipo-momentum-val" style="color:' + scoreColor + '">' + score + '</span>' +
    '</div>' +

    (c.why_explosive_now ? '<div class="preipo-card-section"><div class="preipo-lbl">Why Explosive Now</div><div class="preipo-val">' + c.why_explosive_now + '</div></div>' : '') +

    (signals ? '<div class="preipo-card-section"><div class="preipo-lbl">Hypergrowth Signals</div>' + signals + '</div>' : '') +

    (fundingLine ? '<div class="preipo-card-section"><div class="preipo-lbl">Funding</div><div class="preipo-val">' + fundingLine + '</div></div>' : '') +

    (c.sales_opportunity ? '<div class="preipo-divider"></div><div class="preipo-card-section"><div class="preipo-lbl">Sales Opportunity</div><div class="preipo-val">' + c.sales_opportunity + '</div></div>' : '') +

    (c.estimated_ote_range ? '<div class="preipo-card-section"><div class="preipo-lbl">Est. OTE</div><div class="preipo-val" style="color:var(--gold);font-weight:600">' + c.estimated_ote_range + '</div></div>' : '') +

    (roles ? '<div class="preipo-card-section"><div class="preipo-lbl">Likely Roles</div><div class="preipo-chips">' + roles + '</div></div>' : '') +

    ((equityLine || ipoLine) ? '<div class="preipo-card-section"><div class="preipo-lbl">Equity &amp; Exit</div><div class="preipo-val">' + [equityLine, ipoLine].filter(Boolean).join(' &mdash; ') + '</div></div>' : '') +

    (risks ? '<div class="preipo-divider"></div><div class="preipo-card-section"><div class="preipo-lbl">Risk Flags</div>' + risks + '</div>' : '') +

    (cites ? '<div class="preipo-card-section"><div class="preipo-lbl">Sources</div><div class="preipo-cites">' + cites + '</div></div>' : '') +

    '<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:4px">' +
      '<button class="save-watchlist-btn" onclick="saveToWatchlist(' + JSON.stringify(c.company_name) + ',' + JSON.stringify(c.company_url || '') + ',this)">\u2605 Save Company Profile</button>' +
    '</div>' +
  '</div>';
}

// ── Targeted Company Role Scan (Career Intel + Pre-IPO) ───────────────────

function renderTargetedJobCard(j) {
  var score = j.match_score || 0;
  var scoreColor = score >= 85 ? '#00c86e' : score >= 70 ? '#f5c842' : score >= 55 ? '#7c8dff' : '#888';
  var tier = j.opportunity_tier || '';
  var tierColor = tier === 'Top Target' ? '#00c86e'
    : tier === 'Fast Win' ? '#f5c842'
    : tier === 'Long Shot' ? '#7c8dff'
    : '#888';
  var salaryHtml = j.salary && j.salary !== 'Unknown' && j.salary !== 'N/A' && j.salary.trim()
    ? '<span style="font-size:11px;color:var(--muted)">' + esc(j.salary) + '</span>'
    : '';
  var applyUrl = j.canonical_url || j.apply_url || '#';
  return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:10px">' +
    '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap">' +
      '<div style="flex:1;min-width:0">' +
        '<div style="font-size:14px;font-weight:700;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(j.title) + '</div>' +
        '<div style="font-size:12px;color:var(--muted);margin-top:2px">' +
          esc(j.company) +
          (j.location ? ' &bull; ' + esc(j.location) : '') +
          (salaryHtml ? ' &bull; ' + salaryHtml : '') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;flex-shrink:0">' +
        (score ? '<span style="font-size:13px;font-weight:800;color:' + scoreColor + '">' + score + '</span>' : '') +
        (tier ? '<span style="font-size:10px;font-weight:700;background:' + tierColor + '22;color:' + tierColor + ';border:1px solid ' + tierColor + '55;border-radius:4px;padding:2px 7px">' + esc(tier) + '</span>' : '') +
        '<a href="' + esc(applyUrl) + '" target="_blank" rel="noopener" style="font-size:12px;font-weight:700;background:var(--gold);color:#000;border-radius:6px;padding:5px 12px;text-decoration:none;white-space:nowrap">Apply \u2192</a>' +
      '</div>' +
    '</div>' +
    (j.why_good_fit ? '<div style="font-size:12px;color:var(--muted);margin-top:10px;line-height:1.55;border-left:2px solid var(--gold);padding-left:10px">' + esc(j.why_good_fit) + '</div>' : '') +
  '</div>';
}

async function scanForRoles(source) {
  var isIntel = source === 'intel';
  var isLeaders = source === 'leaders';
  var prefix = isIntel ? 'intel' : (isLeaders ? 'leaders' : 'preipo');
  var companies;
  if (isIntel) {
    companies = _intelCompanies;
  } else if (isLeaders) {
    companies = _leadersAllCompanies;
  } else {
    companies = preIpoAllCompanies.map(function(c) { return c.company_name; }).filter(Boolean);
  }

  if (!companies || companies.length === 0) {
    var errEl = document.getElementById(prefix + '-scan-error');
    if (errEl) { errEl.textContent = 'No companies loaded yet \u2014 generate the radar first.'; errEl.style.display = ''; }
    return;
  }

  var btn = document.getElementById(prefix + '-scan-btn');
  var spinner = document.getElementById(prefix + '-scan-spinner');
  var errBox = document.getElementById(prefix + '-scan-error');
  var resultsBox = document.getElementById(prefix + '-scan-results');

  if (btn) { btn.disabled = true; btn.textContent = 'Scanning\u2026'; }
  if (spinner) spinner.style.display = '';
  if (errBox) { errBox.textContent = ''; errBox.style.display = 'none'; }
  if (resultsBox) resultsBox.style.display = 'none';

  try {
    var res = await fetch('/api/jobs/targeted-scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ companies: companies, source: source })
    });
    var json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Scan failed');

    if (json.skipped) {
      throw new Error('Gemini search not available: ' + (json.skip_reason || 'check GEMINI_API_KEY in Settings'));
    }

    var jobs = json.jobs || [];
    var countEl = document.getElementById(prefix + '-scan-count');
    var jobsEl = document.getElementById(prefix + '-scan-jobs');
    var toggleEl = document.getElementById(prefix + '-scan-toggle');

    if (countEl) countEl.textContent = jobs.length > 0
      ? '\u2705 Found ' + jobs.length + ' matching role' + (jobs.length === 1 ? '' : 's') + ' across ' + companies.length + ' companies'
      : '\u26A0\uFE0F No matching roles found \u2014 try refreshing the radar or adjusting your target roles in Settings';
    if (jobsEl) jobsEl.innerHTML = jobs.length > 0 ? jobs.map(renderTargetedJobCard).join('') : '';
    if (toggleEl) toggleEl.textContent = '\u25B2 Collapse';
    if (resultsBox) resultsBox.style.display = '';

  } catch(e) {
    if (errBox) { errBox.textContent = 'Scan error: ' + e.message; errBox.style.display = ''; }
  } finally {
    if (spinner) spinner.style.display = 'none';
    if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDD0D Find Open Roles'; }
  }
}

var _intelScanCollapsed = false;
function toggleIntelScanResults() {
  _intelScanCollapsed = !_intelScanCollapsed;
  var jobsEl = document.getElementById('intel-scan-jobs');
  var toggleEl = document.getElementById('intel-scan-toggle');
  if (jobsEl) jobsEl.style.display = _intelScanCollapsed ? 'none' : '';
  if (toggleEl) toggleEl.textContent = _intelScanCollapsed ? '\u25BC Expand' : '\u25B2 Collapse';
}

var _preipoScanCollapsed = false;
function togglePreIpoScanResults() {
  _preipoScanCollapsed = !_preipoScanCollapsed;
  var jobsEl = document.getElementById('preipo-scan-jobs');
  var toggleEl = document.getElementById('preipo-scan-toggle');
  if (jobsEl) jobsEl.style.display = _preipoScanCollapsed ? 'none' : '';
  if (toggleEl) toggleEl.textContent = _preipoScanCollapsed ? '\u25BC Expand' : '\u25B2 Collapse';
}

// ── Industry Leaders ──────────────────────────────────────────────────────
var _leadersAllCompanies = [];

function ldEl(id) { return document.getElementById(id); }

function renderLeaderCard(c) {
  var actionClass = c.action === 'apply_now' ? 'action-apply' : c.action === 'network_in' ? 'action-network' : c.action === 'watch' ? 'action-watch' : 'action-monitor';
  var actionLabel = c.action === 'apply_now' ? 'Apply Now' : c.action === 'network_in' ? 'Network In' : c.action === 'watch' ? 'Watch' : 'Monitor';
  var actionBadgeClass = c.action === 'apply_now' ? 'leaders-action-apply' : c.action === 'network_in' ? 'leaders-action-network' : c.action === 'watch' ? 'leaders-action-watch' : 'leaders-action-monitor';
  var websiteUrl = c.website ? (c.website.startsWith('http') ? c.website : 'https://' + c.website) : null;
  return '<div class="leaders-card ' + actionClass + '">' +
    '<div class="leaders-card-top">' +
      '<div class="leaders-rank">' + c.rank + '.</div>' +
      '<div class="leaders-name-block">' +
        '<div class="leaders-name">' + esc(c.name) + '</div>' +
        (websiteUrl ? '<a class="leaders-url" href="' + esc(websiteUrl) + '" target="_blank" rel="noopener">' + esc(c.website) + '</a>' : '') +
      '</div>' +
      '<div class="leaders-badges">' +
        '<span class="leaders-action-badge ' + actionBadgeClass + '">' + actionLabel + '</span>' +
        (c.is_public && c.ticker ? '<span class="leaders-ticker">' + esc(c.ticker) + '</span>' : '') +
        (!c.is_public && c.stage ? '<span class="leaders-stage-badge">' + esc(c.stage) + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="leaders-tagline">' + esc(c.tagline) + '</div>' +
    '<div class="leaders-divider"></div>' +
    '<div><div class="leaders-lbl">Why Sales-Led</div><div class="leaders-val">' + esc(c.why_sales_led) + '</div></div>' +
    '<div><div class="leaders-lbl">Growth Signal</div><div class="leaders-signal">' + esc(c.growth_signal) + '</div></div>' +
    (c.ote_range ? '<div><div class="leaders-lbl">Rep OTE Range</div><div class="leaders-ote">' + esc(c.ote_range) + '</div></div>' : '') +
    '<div><div class="leaders-lbl">Rep Profile</div><div class="leaders-val">' + esc(c.rep_quality) + '</div></div>' +
    '<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:8px">' +
      '<button class="save-watchlist-btn" onclick="saveToWatchlist(' + JSON.stringify(c.name) + ',' + JSON.stringify(websiteUrl || '') + ',this)">\u2605 Save Company Profile</button>' +
    '</div>' +
  '</div>';
}

function renderLeadersSectors(sectors) {
  return sectors.map(function(s) {
    return '<div class="leaders-sector-block">' +
      '<div class="leaders-sector-header">' +
        '<span class="leaders-sector-emoji">' + s.emoji + '</span>' +
        '<div>' +
          '<div class="leaders-sector-name">' + esc(s.sector) + '</div>' +
          '<div class="leaders-sector-ctx">' + esc(s.market_context) + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="leaders-grid">' + (s.companies || []).map(renderLeaderCard).join('') + '</div>' +
    '</div>';
  }).join('');
}

// ── Job Market Pulse ─────────────────────────────────────────────────────────
async function loadJobMarketPulse() {
  var el = function(id) { return document.getElementById(id); };
  try {
    var res = await fetch('/api/job-market-pulse');
    var json = await res.json();
    if (!json.data) {
      el('pulse-empty').style.display = '';
      el('pulse-content').style.display = 'none';
      el('pulse-loading').style.display = 'none';
      el('pulse-meta').textContent = 'No analysis yet \u2014 click Refresh Pulse to generate';
      return;
    }
    renderJobMarketPulse(json.data, json.generated_at, json.stale);
  } catch(e) {
    el('pulse-error').textContent = 'Error loading pulse data: ' + e.message;
    el('pulse-error').style.display = '';
  }
}

async function refreshJobMarketPulse() {
  var el = function(id) { return document.getElementById(id); };
  var btn = el('pulse-refresh-btn');
  btn.disabled = true;
  btn.textContent = 'Refreshing\u2026';
  el('pulse-loading').style.display = '';
  el('pulse-content').style.display = 'none';
  el('pulse-empty').style.display = 'none';
  el('pulse-error').style.display = 'none';
  try {
    var res = await fetch('/api/job-market-pulse/refresh', { method: 'POST' });
    var json = await res.json();
    el('pulse-loading').style.display = 'none';
    if (!res.ok) {
      el('pulse-error').textContent = json.error || 'Refresh failed';
      el('pulse-error').style.display = '';
    } else {
      renderJobMarketPulse(json.data, json.generated_at, false);
    }
  } catch(e) {
    el('pulse-loading').style.display = 'none';
    el('pulse-error').textContent = 'Error: ' + e.message;
    el('pulse-error').style.display = '';
  } finally {
    btn.disabled = false;
    btn.textContent = '\u26A1 Refresh Pulse';
  }
}

function renderJobMarketPulse(data, generatedAt, stale) {
  var el = function(id) { return document.getElementById(id); };
  el('pulse-empty').style.display = 'none';
  el('pulse-loading').style.display = 'none';
  el('pulse-content').style.display = '';

  var genDate = generatedAt ? new Date(generatedAt).toLocaleString() : '';
  el('pulse-meta').textContent = 'Generated ' + genDate + (stale ? ' \u2014 \u26A0\uFE0F Stale (>24h old), refresh for latest' : ' \u2014 Powered by Gemini + Google Search');

  // Mood banner
  var moodMap = {
    hot:     { icon: '\uD83D\uDD25', cls: 'pulse-mood-hot' },
    warm:    { icon: '\u2600\uFE0F', cls: 'pulse-mood-warm' },
    cooling: { icon: '\uD83C\uDF2C\uFE0F', cls: 'pulse-mood-cooling' },
    mixed:   { icon: '\uD83D\uDCA1', cls: 'pulse-mood-mixed' },
  };
  var mood = moodMap[data.market_mood] || moodMap.mixed;
  var banner = el('pulse-mood-banner');
  banner.className = mood.cls;
  banner.style.cssText += ';border-radius:10px;padding:16px 20px;margin-bottom:20px;display:flex;align-items:flex-start;gap:14px';
  el('pulse-mood-icon').textContent = mood.icon;
  el('pulse-headline').textContent = data.pulse_headline || '';
  el('pulse-commentary').textContent = data.market_commentary || '';

  // Stats bar
  var stats = data.stats || {};
  var statsHtml = '';
  statsHtml += '<div class="pulse-stat-card"><div class="pulse-stat-label">Companies Tracked</div><div class="pulse-stat-value">' + (stats.total_companies_tracked || 0) + '</div><div class="pulse-stat-sub">in last 30 days</div></div>';
  statsHtml += '<div class="pulse-stat-card"><div class="pulse-stat-label">Total Jobs Found</div><div class="pulse-stat-value">' + (stats.total_jobs_30d || 0) + '</div><div class="pulse-stat-sub">by the scout</div></div>';
  if (stats.top_roles && stats.top_roles.length > 0) {
    var maxCount = stats.top_roles[0].count || 1;
    var barsHtml = stats.top_roles.slice(0, 5).map(function(r) {
      var pct = Math.round((r.count / maxCount) * 100);
      return '<div class="pulse-role-row"><div class="pulse-role-name">' + esc(r.role) + '</div><div class="pulse-role-bar-wrap"><div class="pulse-role-bar-fill" style="width:' + pct + '%"></div></div><div class="pulse-role-count">' + r.count + '</div></div>';
    }).join('');
    statsHtml += '<div class="pulse-stat-card" style="grid-column:span 2"><div class="pulse-stat-label">Top Roles (Scout Data)</div><div class="pulse-role-bars" style="margin-top:8px">' + barsHtml + '</div></div>';
  }
  el('pulse-stats-bar').innerHTML = statsHtml;

  // Company cards
  var cards = data.companies || [];
  if (cards.length === 0) {
    el('pulse-cards').innerHTML = '<div class="empty">No company cards generated.</div>';
  } else {
    el('pulse-cards').innerHTML = cards.map(renderPulseCard).join('');
  }

  // Footer
  el('pulse-footer').textContent = 'Model: ' + (data.model_used || 'unknown') + ' \u00B7 ' + (data.grounding_sources_count || 0) + ' grounding sources \u00B7 ' + genDate;
}

function renderPulseCard(c) {
  var sigLabels = { true_growth:'True Growth', cautious:'Cautious', hype_risk:'Hype Risk', desperate_hiring:'Desperate Hiring', ai_risk:'AI Risk', unknown:'Unverified' };
  var recLabels = { pursue:'Pursue', watch:'Watch', caution:'Caution', avoid:'Avoid' };
  var sig = c.signal || 'unknown';
  var rec = c.recommendation || 'watch';
  var sigLabel = c.signal_label || sigLabels[sig] || sig;
  var recLabel = recLabels[rec] || rec;

  var evidenceHtml = '';
  if (c.growth_evidence && c.growth_evidence.length > 0) {
    evidenceHtml = '<div class="pulse-section-label">Growth Evidence</div><div class="pulse-evidence-chips">' +
      c.growth_evidence.slice(0,4).map(function(e) { return '<span class="pulse-evidence-chip">' + esc(e) + '</span>'; }).join('') + '</div>';
  }

  var riskHtml = '';
  if (c.risk_flags && c.risk_flags.length > 0) {
    riskHtml = '<div class="pulse-section-label" style="margin-top:4px">Risk Flags</div><div class="pulse-risk-chips">' +
      c.risk_flags.slice(0,4).map(function(r) { return '<span class="pulse-risk-chip">' + esc(r) + '</span>'; }).join('') + '</div>';
  }

  var aiVulnHtml = '';
  if (c.ai_vulnerability) {
    aiVulnHtml = '<div><div class="pulse-section-label" style="color:#a855f7">\uD83E\uDD16 AI Vulnerability</div><div class="pulse-section-value" style="color:#a855f7;opacity:.9">' + esc(c.ai_vulnerability) + '</div></div>';
  }

  var scoutHtml = '';
  if (c.scout_job_count > 0) {
    scoutHtml = '<div class="pulse-scout-row">' +
      '<span class="pulse-scout-stat"><strong>' + c.scout_job_count + '</strong> jobs found</span>' +
      (c.scout_avg_salary ? '<span class="pulse-scout-stat">Avg <strong>$' + Math.round(c.scout_avg_salary / 1000) + 'K</strong> base</span>' : '') +
      (c.scout_roles && c.scout_roles.length > 0 ? '<span class="pulse-scout-stat">' + c.scout_roles.slice(0,3).map(function(r){ return esc(r); }).join(', ') + '</span>' : '') +
    '</div>';
  }

  var citationsHtml = '';
  if (c.source_citations && c.source_citations.length > 0) {
    citationsHtml = '<div style="margin-top:4px">' +
      c.source_citations.slice(0,3).map(function(s) {
        return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener" class="pulse-citation-link">\uD83D\uDD17 ' + esc(s.title || s.url) + '</a>';
      }).join('') + '</div>';
  }

  return '<div class="pulse-card">' +
    '<div class="pulse-card-header">' +
      '<div>' +
        (c.company_url ? '<a href="' + esc(c.company_url) + '" target="_blank" rel="noopener" class="pulse-company-name" style="text-decoration:none">' + esc(c.company_name) + '</a>' : '<div class="pulse-company-name">' + esc(c.company_name) + '</div>') +
        (c.company_url ? '<a href="' + esc(c.company_url) + '" target="_blank" rel="noopener" class="pulse-company-url">' + esc(c.company_url.replace(/^https?:\\/\\//,'').split('\\/')[0]) + '</a>' : '') +
      '</div>' +
      '<div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px">' +
        '<span class="pulse-signal-badge pulse-sig-' + sig + '">' + esc(sigLabel) + '</span>' +
        '<span class="pulse-rec-badge pulse-rec-' + rec + '">' + esc(recLabel) + '</span>' +
      '</div>' +
    '</div>' +
    (scoutHtml ? scoutHtml : '') +
    '<div><div class="pulse-section-label">Signal Rationale</div><div class="pulse-section-value">' + esc(c.signal_rationale) + '</div></div>' +
    (evidenceHtml ? evidenceHtml : '') +
    (riskHtml ? riskHtml : '') +
    (aiVulnHtml ? aiVulnHtml : '') +
    '<div class="pulse-agent-box">' +
      '<div class="pulse-agent-label">\uD83E\uDDE0 Agent Analysis</div>' +
      '<div class="pulse-agent-text">' + esc(c.agent_analysis) + '</div>' +
    '</div>' +
    (c.hiring_driver ? '<div><div class="pulse-section-label">Hiring Driver</div><div class="pulse-section-value" style="color:var(--muted)">' + esc(c.hiring_driver) + '</div></div>' : '') +
    (citationsHtml ? citationsHtml : '') +
    '<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:6px">' +
      '<button class="save-watchlist-btn" onclick="saveToWatchlist(' + JSON.stringify(c.company_name) + ',' + JSON.stringify(c.company_url || '') + ',this)">\u2605 Save Company Profile</button>' +
    '</div>' +
  '</div>';
}

async function loadIndustryLeaders() {
  try {
    var res = await fetch('/api/industry-leaders');
    if (!res.ok) { var j = await res.json(); throw new Error(j.error || 'Failed'); }
    var json = await res.json();
    if (!json.data) {
      ldEl('leaders-empty').style.display = '';
      ldEl('leaders-content').style.display = 'none';
      ldEl('leaders-loading').style.display = 'none';
      ldEl('leaders-error').style.display = 'none';
      return;
    }
    renderIndustryLeadersData(json.data, json.stale);
  } catch(e) {
    ldEl('leaders-error').textContent = 'Error loading Industry Leaders: ' + e.message;
    ldEl('leaders-error').style.display = '';
    ldEl('leaders-loading').style.display = 'none';
    ldEl('leaders-empty').style.display = 'none';
    ldEl('leaders-content').style.display = 'none';
  }
}

function renderIndustryLeadersData(data, stale) {
  var sectors = data.sectors || [];
  _leadersAllCompanies = [];
  sectors.forEach(function(s) {
    (s.companies || []).forEach(function(c) { if (c.name) _leadersAllCompanies.push(c.name); });
  });

  ldEl('leaders-overview').textContent = data.market_overview || '';
  ldEl('leaders-sectors').innerHTML = renderLeadersSectors(sectors);

  var genAt = data.generated_at ? new Date(data.generated_at) : null;
  var metaParts = [];
  if (genAt) metaParts.push('Last updated ' + genAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  if (stale) metaParts.push('\u26A0\uFE0F Data may be stale — click Refresh');
  ldEl('leaders-meta').textContent = metaParts.length ? metaParts.join(' \u2014 ') : 'Claude-ranked top sales-led companies per sector';

  var sectorCount = sectors.length;
  var coCount = _leadersAllCompanies.length;
  ldEl('leaders-footer').textContent = sectorCount + ' sectors \u2014 ' + coCount + ' companies \u2014 Powered by Claude \u2014 ' + (data.model_used || 'claude');

  ldEl('leaders-loading').style.display = 'none';
  ldEl('leaders-empty').style.display = 'none';
  ldEl('leaders-error').style.display = 'none';
  ldEl('leaders-content').style.display = '';

  var btn = ldEl('leaders-refresh-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Refresh Leaders'; }
}

async function refreshIndustryLeaders() {
  var btn = ldEl('leaders-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing\u2026'; }
  ldEl('leaders-loading').style.display = '';
  ldEl('leaders-content').style.display = 'none';
  ldEl('leaders-empty').style.display = 'none';
  ldEl('leaders-error').style.display = 'none';
  try {
    var res = await fetch('/api/industry-leaders/refresh', { method: 'POST' });
    var json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Refresh failed');
    renderIndustryLeadersData(json.data, false);
  } catch(e) {
    ldEl('leaders-error').textContent = 'Refresh failed: ' + e.message;
    ldEl('leaders-error').style.display = '';
    ldEl('leaders-loading').style.display = 'none';
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Leaders'; }
  }
}

var _leadersScanCollapsed = false;
function toggleLeadersScanResults() {
  _leadersScanCollapsed = !_leadersScanCollapsed;
  var jobsEl = document.getElementById('leaders-scan-jobs');
  var toggleEl = document.getElementById('leaders-scan-toggle');
  if (jobsEl) jobsEl.style.display = _leadersScanCollapsed ? 'none' : '';
  if (toggleEl) toggleEl.textContent = _leadersScanCollapsed ? '\u25BC Expand' : '\u25B2 Collapse';
}

// ── Industry News ─────────────────────────────────────────────────────────────
var _newsData = [];
var _newsFilter = 'all';
var _newsSignals = { hiring: false, funded: false };
var _newsLoaded = false;

function newsEl(id) { return document.getElementById(id); }

async function loadNews(force) {
  if (_newsLoaded && !force) return;
  var grid = newsEl('news-grid');
  if (grid) grid.innerHTML = '<div class="news-loading">Loading news feed\u2026</div>';
  try {
    var res = await fetch('/api/industry-news');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var json = await res.json();
    _newsData = json.articles || [];
    _newsLoaded = true;
    renderNewsGrid();
    var meta = json.meta;
    var metaEl = newsEl('news-meta');
    if (metaEl && meta) {
      var ts = meta.generated_at ? new Date(meta.generated_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
      metaEl.textContent = ts ? 'Updated ' + ts : '';
    }
    var footerEl = newsEl('news-footer');
    if (footerEl) {
      if (!_newsData.length) {
        footerEl.textContent = 'No articles yet \u2014 click Refresh Feed to pull fresh B2B news';
      } else {
        footerEl.textContent = _newsData.length + ' articles \u00B7 powered by Gemini + Google Search grounding';
      }
    }
  } catch(e) {
    if (grid) grid.innerHTML = '<div class="news-empty">Failed to load news: ' + esc(e.message) + '</div>';
  }
}

function renderNewsGrid() {
  var grid = newsEl('news-grid');
  if (!grid) return;
  var filtered = _newsData.filter(function(a) {
    var sectorMatch = _newsFilter === 'all' || (a.sector || '').toLowerCase().includes(_newsFilter.toLowerCase());
    var hiringMatch = !_newsSignals.hiring || ['STRONG','MODERATE'].includes((a.hiring_signal || '').split('\u2014')[0].trim().toUpperCase().split(' ')[0]);
    var fundedMatch = !_newsSignals.funded || (a.funding_stage && a.funding_stage !== 'Unknown' && a.funding_stage !== '');
    return sectorMatch && hiringMatch && fundedMatch;
  });
  if (!filtered.length) {
    grid.innerHTML = '<div class="news-empty">No articles match this filter \u2014 try broadening your selection</div>';
    return;
  }
  grid.innerHTML = filtered.map(renderNewsCard).join('');
}

function renderNewsCard(a) {
  var hiringSignalRaw = (a.hiring_signal || '').split('\u2014')[0].split('—')[0].trim().toUpperCase().split(' ')[0];
  var hiringClass = hiringSignalRaw === 'STRONG' ? 'news-badge-hiring-strong' :
    hiringSignalRaw === 'MODERATE' ? 'news-badge-hiring-moderate' :
    hiringSignalRaw === 'LOW' ? 'news-badge-hiring-low' :
    hiringSignalRaw === 'NONE' ? 'news-badge-hiring-none' : 'news-badge-hiring-unknown';
  var hiringLabel = hiringSignalRaw === 'STRONG' ? '\u2714 Actively Hiring' :
    hiringSignalRaw === 'MODERATE' ? '\u2714 Some Hiring' :
    hiringSignalRaw === 'LOW' ? 'Minimal Hiring' :
    hiringSignalRaw === 'NONE' ? 'Not Hiring' : 'Hiring Unknown';

  var score = a.relevance_score || 0;
  var sector = a.sector || '';
  var tags = (a.tags || []).slice(0, 4);
  var pub = a.published_at ? new Date(a.published_at) : null;
  var ageStr = '';
  if (pub) {
    var diffH = Math.round((Date.now() - pub.getTime()) / 3600000);
    ageStr = diffH < 1 ? 'Just now' : diffH < 24 ? diffH + 'h ago' : Math.floor(diffH/24) + 'd ago';
  }

  var tagsHtml = tags.map(function(t) { return '<span class="news-badge news-badge-sector">' + esc(t) + '</span>'; }).join('');
  var fundingHtml = a.funding_stage && a.funding_stage !== 'Unknown'
    ? '<span class="news-badge news-badge-funding">' + esc(a.funding_stage) + '</span>' : '';
  var territoryHtml = a.sales_territory && a.sales_territory !== 'Unknown'
    ? '<span class="news-badge news-badge-territory">' + esc(a.sales_territory) + '</span>' : '';

  return '<div class="news-card">' +
    '<div class="news-card-top">' +
      '<div>' +
        '<div class="news-card-company">' + esc(a.company_name || 'Unknown') + '</div>' +
        '<div class="news-card-source">' + esc(a.source_name || '') + (ageStr ? ' \u00B7 ' + ageStr : '') + '</div>' +
      '</div>' +
      (score ? '<div class="news-card-score">' + score + '</div>' : '') +
    '</div>' +

    '<div class="news-card-title"><a href="' + esc(a.article_url) + '" target="_blank" rel="noopener">' + esc(a.title) + '</a></div>' +

    '<hr class="news-card-divider">' +

    (a.summary ? '<div class="news-card-summary">' + esc(a.summary) + '</div>' : '') +
    (a.why_it_matters ? '<div class="news-card-matters">' + esc(a.why_it_matters) + '</div>' : '') +

    '<div class="news-meta-row">' +
      (sector ? '<span class="news-badge news-badge-sector">' + esc(sector) + '</span>' : '') +
      '<span class="news-badge ' + hiringClass + '">' + hiringLabel + '</span>' +
      fundingHtml +
      territoryHtml +
    '</div>' +

    (tagsHtml ? '<div class="news-meta-row">' + tagsHtml + '</div>' : '') +

    (a.employee_count_est && a.employee_count_est !== 'Unknown'
      ? '<div style="font-size:10px;color:var(--muted)">\uD83D\uDC65 ' + esc(a.employee_count_est) + ' employees</div>' : '') +

    '<div class="news-card-actions">' +
      '<button class="save-watchlist-btn" onclick="saveToWatchlist(' + JSON.stringify(a.company_name || '') + ',null,this)">\u2605 Save Company</button>' +
      '<a href="' + esc(a.article_url) + '" target="_blank" rel="noopener" class="btn btn-ghost btn-sm" style="font-size:11px">Read \u2192</a>' +
    '</div>' +
  '</div>';
}

function setNewsFilter(sector, btn) {
  _newsFilter = sector;
  document.querySelectorAll('.news-filter-btn').forEach(function(b) { b.classList.remove('active'); });
  if (btn) btn.classList.add('active');
  renderNewsGrid();
}

function toggleNewsSignal(signal, btn) {
  _newsSignals[signal] = !_newsSignals[signal];
  if (btn) btn.classList.toggle('active', _newsSignals[signal]);
  renderNewsGrid();
}

async function refreshNews() {
  var btn = newsEl('news-refresh-btn');
  var metaEl = newsEl('news-meta');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching\u2026'; }
  if (metaEl) metaEl.textContent = 'Pulling RSS feeds and analyzing with Gemini\u2026';
  var grid = newsEl('news-grid');
  if (grid) grid.innerHTML = '<div class="news-loading">\uD83E\uDD16 Gemini is reading the news\u2026 (30-60 seconds)</div>';
  try {
    var startRes = await fetch('/api/industry-news/refresh', { method: 'POST' });
    var startData = await startRes.json();
    if (!startData.started) {
      if (metaEl) metaEl.textContent = startData.message || 'Could not start refresh';
      if (btn) { btn.disabled = false; btn.textContent = '\u21BB Refresh Feed'; }
      return;
    }
    // Poll until new data appears
    var attempts = 0;
    var poll = setInterval(async function() {
      attempts++;
      if (attempts > 40) {
        clearInterval(poll);
        if (btn) { btn.disabled = false; btn.textContent = '\u21BB Refresh Feed'; }
        await loadNews(true);
        return;
      }
      try {
        var checkRes = await fetch('/api/industry-news');
        var checkData = await checkRes.json();
        if (checkData.articles && checkData.articles.length > (_newsData.length || 0)) {
          clearInterval(poll);
          _newsData = checkData.articles;
          _newsLoaded = true;
          renderNewsGrid();
          var meta = checkData.meta;
          if (metaEl && meta) {
            var ts = meta.generated_at ? new Date(meta.generated_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '';
            metaEl.textContent = ts ? 'Updated ' + ts : '';
          }
          var footerEl = newsEl('news-footer');
          if (footerEl) footerEl.textContent = _newsData.length + ' articles \u00B7 powered by Gemini + Google Search grounding';
          if (btn) { btn.disabled = false; btn.textContent = '\u21BB Refresh Feed'; }
        }
      } catch { /* keep polling */ }
    }, 5000);
  } catch(e) {
    if (metaEl) metaEl.textContent = 'Refresh failed: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = '\u21BB Refresh Feed'; }
  }
}

// ── Deep Value ──────────────────────────────────────────────────────────────
var _dvWatchlistAdded = {};

function dvEl(id) { return document.getElementById(id); }

function renderDvRolesSection(c) {
  var roles = c.open_roles || [];
  if (roles.length > 0) {
    return '<div class="dv-divider"></div>' +
      '<div class="dv-roles-section">' +
        '<div class="dv-roles-label">\u2705 ' + roles.length + ' Open Role' + (roles.length > 1 ? 's' : '') + ' Found</div>' +
        roles.map(function(r) {
          var applyHref = r.apply_url || (c.website ? ('https://' + c.website.replace(/^https?:\\/\\//, '') + '/careers') : '#');
          return '<div class="dv-role-row">' +
            '<span class="dv-role-title">' + esc(r.title) + '</span>' +
            (r.location ? '<span class="dv-role-loc">' + esc(r.location) + '</span>' : '') +
            '<a class="dv-role-apply" href="' + esc(applyHref) + '" target="_blank" rel="noopener">Apply \u2192</a>' +
          '</div>';
        }).join('') +
      '</div>';
  }
  return '<div class="dv-divider"></div>' +
    '<div class="dv-no-roles">' +
      '<span class="dv-no-roles-text">\u26A0\uFE0F No open matching roles found right now</span>' +
    '</div>';
}

function renderDvCard(c) {
  var hasRoles = c.has_open_roles && (c.open_roles || []).length > 0;
  var websiteUrl = c.website ? (c.website.startsWith('http') ? c.website : 'https://' + c.website) : null;
  return '<div class="dv-card ' + (hasRoles ? 'has-roles' : 'no-roles') + '">' +
    '<div class="dv-card-top">' +
      '<div class="dv-name-block">' +
        '<div class="dv-name">' + esc(c.name) + '</div>' +
        (websiteUrl ? '<a class="dv-url" href="' + esc(websiteUrl) + '" target="_blank" rel="noopener">' + esc(c.website) + '</a>' : '') +
      '</div>' +
      '<div class="dv-badges">' +
        '<span class="dv-category-badge">' + esc(c.category) + '</span>' +
        (c.is_public && c.ticker ? '<span class="dv-public-badge">' + esc(c.ticker) + '</span>' : '') +
        (!c.is_public && c.stage ? '<span class="dv-private-badge">' + esc(c.stage) + '</span>' : '') +
      '</div>' +
    '</div>' +
    '<div class="dv-tagline">' + esc(c.tagline) + '</div>' +
    '<div class="dv-why">\u201C' + esc(c.why_you_need_this) + '\u201D</div>' +
    '<div><div class="dv-lbl">Customer Pain Solved</div><div class="dv-val">' + esc(c.customer_pain) + '</div></div>' +
    '<div class="dv-signal">' + esc(c.growth_signal) + '</div>' +
    (c.notable_customers && c.notable_customers.length ?
      '<div><div class="dv-lbl">Notable Customers</div><div class="dv-customers">' +
        c.notable_customers.map(function(cu) { return '<span class="dv-customer-chip">' + esc(cu) + '</span>'; }).join('') +
      '</div></div>' : '') +
    renderDvRolesSection(c) +
    ((c.source_citations || []).length ?
      '<div class="dv-cites">' + c.source_citations.slice(0, 2).map(function(s) {
        return '<a class="dv-cite" href="' + esc(s.url) + '" target="_blank" rel="noopener">\uD83D\uDD17 ' + esc(s.title) + '</a>';
      }).join('') + '</div>' : '') +
    '<div style="border-top:1px solid var(--border);padding-top:10px;margin-top:8px">' +
      '<button class="save-watchlist-btn" onclick="saveToWatchlist(' + JSON.stringify(c.name) + ',' + JSON.stringify(websiteUrl || '') + ',this)">\u2605 Save Company Profile</button>' +
    '</div>' +
  '</div>';
}

function renderDvData(data, stale) {
  dvEl('dv-summary').textContent = data.market_summary || '';
  dvEl('dv-grid').innerHTML = (data.companies || []).map(renderDvCard).join('');

  var genAt = data.generated_at ? new Date(data.generated_at) : null;
  var metaParts = [];
  if (genAt) metaParts.push('Last updated ' + genAt.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  if (stale) metaParts.push('\u26A0\uFE0F Stale \u2014 click Refresh Intel');
  metaParts.push('Powered by Gemini + Google Search');
  dvEl('dv-meta').textContent = metaParts.join(' \u2014 ');

  var cos = data.companies || [];
  dvEl('dv-footer').textContent =
    cos.length + ' companies \u2014 ' + cos.filter(function(c) { return c.has_open_roles; }).length + ' with open roles \u2014 ' + (data.model_used || 'Gemini');

  dvEl('dv-loading').style.display = 'none';
  dvEl('dv-empty').style.display = 'none';
  dvEl('dv-error').style.display = 'none';
  dvEl('dv-content').style.display = '';
  var btn = dvEl('dv-refresh-btn');
  if (btn) { btn.disabled = false; btn.textContent = 'Refresh Intel'; }
}

async function loadDeepValue() {
  try {
    var res = await fetch('/api/deep-value');
    var json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Failed');
    if (!json.data) {
      dvEl('dv-empty').style.display = '';
      dvEl('dv-content').style.display = 'none';
      dvEl('dv-loading').style.display = 'none';
      dvEl('dv-error').style.display = 'none';
      return;
    }
    renderDvData(json.data, json.stale);
  } catch(e) {
    dvEl('dv-error').textContent = 'Error loading Deep Value: ' + e.message;
    dvEl('dv-error').style.display = '';
    dvEl('dv-loading').style.display = 'none';
    dvEl('dv-empty').style.display = 'none';
    dvEl('dv-content').style.display = 'none';
  }
}

async function refreshDeepValue() {
  var btn = dvEl('dv-refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing\u2026'; }
  dvEl('dv-loading').style.display = '';
  dvEl('dv-content').style.display = 'none';
  dvEl('dv-empty').style.display = 'none';
  dvEl('dv-error').style.display = 'none';
  try {
    var res = await fetch('/api/deep-value/refresh', { method: 'POST' });
    var json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Refresh failed');
    renderDvData(json.data, false);
  } catch(e) {
    dvEl('dv-error').textContent = 'Refresh failed: ' + e.message;
    dvEl('dv-error').style.display = '';
    dvEl('dv-loading').style.display = 'none';
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Intel'; }
  }
}

async function addDvCompanyToWatchlist(name, website, btn) {
  if (!name) return;
  try {
    btn.disabled = true;
    btn.textContent = 'Adding\u2026';
    var res = await fetch('/api/companies/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, website: website || undefined })
    });
    var data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed');
    _dvWatchlistAdded[name] = true;
    btn.textContent = '\u2713 On Watchlist';
    btn.classList.add('added');
    btn.disabled = true;
  } catch(e) {
    btn.textContent = 'Error \u2014 retry?';
    btn.disabled = false;
    console.error('Add to watchlist failed:', e);
  }
}

// ── Company Watchlist scan ──────────────────────────────────────────────────
var _cwJobStatus = {};

async function loadCwJobStatus() {
  try {
    var res = await fetch('/api/companies/job-status');
    var data = await res.json();
    _cwJobStatus = {};
    (data || []).forEach(function(entry) {
      _cwJobStatus[entry.company_name.toLowerCase()] = entry;
    });
  } catch(e) {}
}

async function runWatchlistScan() {
  var btn = document.getElementById('cw-scan-btn');
  var statusEl = document.getElementById('cw-scan-status');
  if (btn) { btn.disabled = true; btn.textContent = 'Scanning\u2026'; }
  if (statusEl) statusEl.textContent = 'Gemini is searching for open roles at each company\u2026 (30-90s per company)';
  try {
    var res = await fetch('/api/companies/scan-jobs', { method: 'POST' });
    var data = await res.json();
    if (data.started) {
      if (statusEl) statusEl.textContent = 'Scan started for ' + data.count + ' companies \u2014 results will appear as they come in';
      // Poll for completion
      var pollCount = 0;
      var poll = setInterval(async function() {
        pollCount++;
        await loadCwJobStatus();
        loadCompanies();
        if (pollCount > 120) {
          clearInterval(poll);
          if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDD0D Scan Now'; }
          if (statusEl) statusEl.textContent = 'Scan complete \u2014 results updated';
        }
      }, 5000);
    } else {
      if (statusEl) statusEl.textContent = data.message || 'Could not start scan';
      if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDD0D Scan Now'; }
    }
  } catch(e) {
    if (statusEl) statusEl.textContent = 'Scan error: ' + e.message;
    if (btn) { btn.disabled = false; btn.textContent = '\uD83D\uDD0D Scan Now'; }
  }
}

// ── Positioning Engine ────────────────────────────────────────────────────
var posStories = [];

function posShowStep(step) {
  document.querySelectorAll('.pos-step-btn').forEach(function(b) {
    b.classList.toggle('active', b.getAttribute('data-step') === step);
  });
  document.querySelectorAll('.pos-section').forEach(function(s) {
    s.classList.toggle('active', s.id === 'pos-' + step);
  });
}

async function loadPositioning() {
  try {
    var p = await fetch('/api/positioning/profile').then(function(r){return r.json();});
    if (p && p.target_role) {
      document.getElementById('pi-target-role').value = p.target_role || '';
      document.getElementById('pi-target-industry').value = p.target_industry || '';
      document.getElementById('pi-top-wins').value = p.top_wins || '';
      document.getElementById('pi-strengths').value = p.strengths || '';
      document.getElementById('pi-want-next').value = p.want_next || '';
      document.getElementById('pi-dont-want').value = p.dont_want || '';
      document.getElementById('pi-pivot-concerns').value = p.pivot_concerns || '';
      document.getElementById('pi-why-now').value = p.why_now || '';
      document.getElementById('pi-biggest-objection').value = p.biggest_objection || '';
    }
    await loadStories();
    await loadOutputs();
    await loadObjections();
    await loadNarrative();
  } catch(e) { console.error('loadPositioning', e); }
}

async function saveIntake() {
  var body = {
    target_role: document.getElementById('pi-target-role').value,
    target_industry: document.getElementById('pi-target-industry').value,
    past_roles: '',
    top_wins: document.getElementById('pi-top-wins').value,
    strengths: document.getElementById('pi-strengths').value,
    want_next: document.getElementById('pi-want-next').value,
    dont_want: document.getElementById('pi-dont-want').value,
    pivot_concerns: document.getElementById('pi-pivot-concerns').value,
    why_now: document.getElementById('pi-why-now').value,
    biggest_objection: document.getElementById('pi-biggest-objection').value
  };
  if (!body.target_role.trim()) { alert('Target Role is required.'); return; }
  var r = await fetch('/api/positioning/profile', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.ok) {
    var m = document.getElementById('intake-msg');
    m.style.display = 'inline';
    setTimeout(function(){ m.style.display = 'none'; }, 2000);
  }
}

// Story Bank
async function loadStories() {
  posStories = await fetch('/api/positioning/stories').then(function(r){return r.json();});
  renderStories();
}

function renderStories() {
  var el = document.getElementById('story-list');
  if (!posStories.length) { el.innerHTML = '<div class="pos-empty">No stories yet. Add your first one.</div>'; return; }
  var conf = ['','★','★★','★★★','★★★★','★★★★★'];
  el.innerHTML = posStories.map(function(s) {
    var tags = (s.themes||[]).map(function(t){ return '<span class="pos-story-tag">'+t+'</span>'; }).join('');
    return '<div class="pos-story-card">' +
      '<div class="pos-story-body">' +
        '<div class="pos-story-title">'+esc(s.title)+'</div>' +
        '<div class="pos-story-car"><b>Context:</b> '+esc(s.context)+'<br><b>Action:</b> '+esc(s.action)+'<br><b>Result:</b> '+esc(s.result)+'</div>' +
        (s.metrics ? '<div class="pos-story-car" style="margin-top:4px"><b>Metrics:</b> '+esc(s.metrics)+'</div>' : '') +
        '<div class="pos-story-tags">'+tags+'</div>' +
        '<div class="pos-story-conf">Confidence: '+conf[s.confidence||3]+'</div>' +
      '</div>' +
      '<div class="pos-story-actions">' +
        '<button class="btn" style="padding:4px 10px;font-size:12px" onclick="editStory('+s.id+')">Edit</button>' +
        '<button class="btn" style="padding:4px 10px;font-size:12px;color:#ff6b6b" onclick="deleteStory('+s.id+')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

function openStoryModal(story) {
  document.getElementById('story-modal-title').textContent = story ? 'Edit Story' : 'Add Story';
  document.getElementById('story-edit-id').value = story ? story.id : '';
  document.getElementById('sm-title').value = story ? story.title : '';
  document.getElementById('sm-context').value = story ? story.context : '';
  document.getElementById('sm-action').value = story ? story.action : '';
  document.getElementById('sm-result').value = story ? story.result : '';
  document.getElementById('sm-metrics').value = story ? story.metrics : '';
  document.querySelectorAll('#sm-themes input[type=checkbox]').forEach(function(cb) {
    cb.checked = story && story.themes && story.themes.includes(cb.value);
  });
  var conf = story ? story.confidence : 3;
  document.querySelectorAll('input[name=sm-conf]').forEach(function(r) {
    r.checked = parseInt(r.value) === conf;
  });
  document.getElementById('story-modal').style.display = 'flex';
}

function editStory(id) {
  var s = posStories.find(function(x){ return x.id === id; });
  if (s) openStoryModal(s);
}

function closeStoryModal() { document.getElementById('story-modal').style.display = 'none'; }

async function saveStoryModal() {
  var themes = [];
  document.querySelectorAll('#sm-themes input[type=checkbox]:checked').forEach(function(cb){ themes.push(cb.value); });
  var confEl = document.querySelector('input[name=sm-conf]:checked');
  var story = {
    id: document.getElementById('story-edit-id').value ? parseInt(document.getElementById('story-edit-id').value) : undefined,
    title: document.getElementById('sm-title').value,
    context: document.getElementById('sm-context').value,
    action: document.getElementById('sm-action').value,
    result: document.getElementById('sm-result').value,
    metrics: document.getElementById('sm-metrics').value,
    themes: themes,
    confidence: confEl ? parseInt(confEl.value) : 3
  };
  if (!story.title.trim()) { alert('Title is required.'); return; }
  await fetch('/api/positioning/stories', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(story) });
  closeStoryModal();
  await loadStories();
}

async function deleteStory(id) {
  if (!confirm('Delete this story?')) return;
  await fetch('/api/positioning/stories/'+id, { method:'DELETE' });
  await loadStories();
}

// Outputs
var POS_OUTPUT_LABELS = {
  professional_summary:'Professional Summary',
  linkedin_headline:'LinkedIn Headline',
  linkedin_about:'LinkedIn About',
  elevator_pitch:'Elevator Pitch',
  recruiter_intro:'Recruiter Intro',
  tell_me_about_yourself:'Tell Me About Yourself',
  cover_letter_themes:'Cover Letter Themes',
  networking_bio:'Networking Bio'
};

async function loadOutputs() {
  var data = await fetch('/api/positioning/outputs').then(function(r){return r.json();});
  renderOutputs(data);
}

function renderOutputs(data) {
  var el = document.getElementById('pos-outputs-container');
  var keys = Object.keys(POS_OUTPUT_LABELS);
  var hasContent = keys.some(function(k){ return data && data[k]; });
  if (!hasContent) {
    el.innerHTML = '<div class="pos-empty">No outputs yet. Save your intake and click Generate All.</div>';
    return;
  }
  el.innerHTML = keys.map(function(k) {
    var text = data[k] || '';
    return '<div class="pos-output-card">' +
      '<div class="pos-output-label">'+POS_OUTPUT_LABELS[k]+'</div>' +
      '<div class="pos-output-text">'+esc(text)+'</div>' +
      '<button class="pos-output-copy" onclick="copyText('+JSON.stringify(text)+')">Copy</button>' +
    '</div>';
  }).join('');
  if (data.generated_at) {
    var st = document.getElementById('pos-outputs-status');
    st.textContent = 'Generated ' + new Date(data.generated_at).toLocaleString() + (data.model_used ? ' · ' + data.model_used : '');
    st.style.display = 'block';
  }
}

async function generateOutputs() {
  var st = document.getElementById('pos-outputs-status');
  st.textContent = 'Generating all outputs with Claude... this may take 30-60 seconds.';
  st.style.display = 'block';
  document.getElementById('pos-outputs-container').innerHTML = '';
  try {
    var data = await fetch('/api/positioning/generate', { method:'POST' }).then(function(r){return r.json();});
    if (data.error) { st.textContent = 'Error: ' + data.error; return; }
    renderOutputs(data);
  } catch(e) { st.textContent = 'Error: ' + String(e); }
}

// Objections
async function loadObjections() {
  var data = await fetch('/api/positioning/objections').then(function(r){return r.json();});
  renderObjections(data);
}

function renderObjections(data) {
  var el = document.getElementById('pos-obj-container');
  if (!data || !data.objections || !data.objections.length) {
    el.innerHTML = '<div class="pos-empty">No objection guide yet. Save your intake and click Generate Objections.</div>';
    return;
  }
  var st = document.getElementById('pos-obj-status');
  if (data.generated_at) { st.textContent = 'Generated ' + new Date(data.generated_at).toLocaleString(); st.style.display = 'block'; }
  el.innerHTML = data.objections.map(function(o, i) {
    return '<div class="pos-obj-card">' +
      '<div class="pos-obj-title">'+(i+1)+'. '+esc(o.objection)+'</div>' +
      '<div class="pos-obj-row"><span class="pos-obj-key">Why it arises</span><span class="pos-obj-val">'+esc(o.why_it_arises)+'</span></div>' +
      '<div class="pos-obj-row"><span class="pos-obj-key">How to address</span><span class="pos-obj-val">'+esc(o.how_to_address)+'</span></div>' +
      '<div class="pos-obj-row"><span class="pos-obj-key">Best proof points</span><span class="pos-obj-val">'+esc(o.best_proof_points)+'</span></div>' +
    '</div>';
  }).join('');
}

async function generateObjections() {
  var st = document.getElementById('pos-obj-status');
  st.textContent = 'Analyzing your profile and generating objection guide...';
  st.style.display = 'block';
  document.getElementById('pos-obj-container').innerHTML = '';
  try {
    var data = await fetch('/api/positioning/generate-objections', { method:'POST' }).then(function(r){return r.json();});
    if (data.error) { st.textContent = 'Error: ' + data.error; return; }
    renderObjections(data);
  } catch(e) { st.textContent = 'Error: ' + String(e); }
}

// Core Narrative
async function loadNarrative() {
  var data = await fetch('/api/positioning/narrative').then(function(r){return r.json();});
  if (data && data.target_narrative) {
    document.getElementById('pn-target-narrative').value = data.target_narrative || '';
    document.getElementById('pn-why-me').value = data.why_me || '';
    document.getElementById('pn-why-now').value = data.why_now || '';
    document.getElementById('pn-category').value = data.category_positioning || '';
    document.getElementById('pn-ideal-role').value = data.ideal_role_thesis || '';
    var badge = document.getElementById('pos-narr-approved-badge');
    badge.style.display = data.approved ? 'inline-flex' : 'none';
  }
}

async function draftNarrative() {
  var st = document.getElementById('pos-narr-status');
  st.textContent = 'Drafting your core narrative with Claude...';
  st.style.display = 'block';
  try {
    var data = await fetch('/api/positioning/draft-narrative', { method:'POST' }).then(function(r){return r.json();});
    if (data.error) { st.textContent = 'Error: ' + data.error; return; }
    document.getElementById('pn-target-narrative').value = data.target_narrative || '';
    document.getElementById('pn-why-me').value = data.why_me || '';
    document.getElementById('pn-why-now').value = data.why_now || '';
    document.getElementById('pn-category').value = data.category_positioning || '';
    document.getElementById('pn-ideal-role').value = data.ideal_role_thesis || '';
    document.getElementById('pos-narr-approved-badge').style.display = 'none';
    st.textContent = 'Draft ready. Review and edit, then click Approve & Save.';
  } catch(e) { st.textContent = 'Error: ' + String(e); }
}

async function approveNarrative() {
  var body = {
    target_narrative: document.getElementById('pn-target-narrative').value,
    why_me: document.getElementById('pn-why-me').value,
    why_now: document.getElementById('pn-why-now').value,
    category_positioning: document.getElementById('pn-category').value,
    ideal_role_thesis: document.getElementById('pn-ideal-role').value,
    approved: true
  };
  if (!body.target_narrative.trim()) { alert('Target Narrative is required before approving.'); return; }
  var r = await fetch('/api/positioning/narrative', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  if (r.ok) {
    document.getElementById('pos-narr-approved-badge').style.display = 'inline-flex';
    var st = document.getElementById('pos-narr-status');
    st.textContent = 'Core narrative approved and saved.';
    st.style.display = 'block';
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(function(){}).catch(function(){ console.warn('clipboard copy failed'); });
}

// ── init ──────────────────────────────────────────────────────────────────
loadJobs();
loadStats();
loadGmailStatus();
loadCriteria();  // always load settings from DB on page load so they survive refresh/redeploy
loadAutoRunBadge();
// If a run was already in progress when page loaded, resume polling
(async function() {
  try {
    var r = await fetch('/api/scout/status');
    var runs = await r.json();
    var latest = runs[0];
    if (latest && latest.status === 'running') {
      document.getElementById('dot').className = 'dot running';
      document.getElementById('run-btn').disabled = true;
      document.getElementById('run-msg').textContent = 'Scout run in progress\u2026';
      if (latest.current_stage) {
        var stg = document.getElementById('run-stage');
        if (stg) { stg.textContent = latest.current_stage; stg.style.display = 'inline'; }
      }
      // Resume polling
      if (!pollTimer) {
        pollTimer = setInterval(async function() {
          try {
            var r2 = await fetch('/api/scout/status');
            var runs2 = await r2.json();
            var l2 = runs2[0];
            if (!l2) return;
            var stg2 = document.getElementById('run-stage');
            if (l2.current_stage && stg2) { stg2.textContent = l2.current_stage; stg2.style.display = 'inline'; }
            if (l2.status !== 'running') {
              clearInterval(pollTimer); pollTimer = null;
              document.getElementById('run-btn').disabled = false;
              if (stg2) stg2.style.display = 'none';
              document.getElementById('dot').className = 'dot';
              loadStats(); loadJobs(); loadAutoRunBadge();
              var found = l2.matches_found || l2.jobs_found || 0;
              document.getElementById('run-msg').textContent = l2.status === 'completed' ? 'Done! ' + found + ' matches found' : 'Run failed: ' + (l2.error || 'unknown');
            }
          } catch(e2) {}
        }, 3000);
      }
    }
  } catch(e) {}
})();
</script>
</body>
</html>`;

// suppress TS "unused" warning
void esc;
