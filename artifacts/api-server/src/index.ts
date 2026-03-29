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
import { generateCareerIntel } from './career_intel.js';
import type { CareerIntelCriteria } from './career_intel.js';
import { scoreJobsWithClaude, tailorResumeWithClaude, researchCompanyWithClaude, filterUnsafeCompanies, rescoreJobOpportunity, computeTier } from './agent.js';
import type { SubScores, OpportunityTier, TierSettings, TailoringAnalysis } from './agent.js';
import { estimateSalary, type SalaryEstimate } from './lib/salary.js';
// RepVue: link-out only (no scraping — RepVue blocks automated requests)

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT) || 8080;

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
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'https://c12ad21f-8216-45ab-b03f-5e735925225d-00-34c2t5oabpvff.riker.replit.dev/api/gmail/callback';

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

    CREATE TABLE IF NOT EXISTS tailored_docs (
      id           SERIAL PRIMARY KEY,
      job_id       INT     REFERENCES jobs(id),
      resume_text  TEXT    NOT NULL DEFAULT '',
      cover_letter TEXT    NOT NULL DEFAULT '',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS gmail_tokens (
      id            SERIAL PRIMARY KEY,
      access_token  TEXT NOT NULL,
      refresh_token TEXT,
      expiry        TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS research_briefs (
      id           SERIAL PRIMARY KEY,
      company_name TEXT NOT NULL,
      brief_json   JSONB NOT NULL,
      saved        BOOLEAN NOT NULL DEFAULT false,
      created_at   TIMESTAMP DEFAULT NOW()
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
  `);

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
  await safeAddColumn('scout_runs', 'matches_found', 'INT NOT NULL DEFAULT 0');
  await safeAddColumn('jobs', 'source', "TEXT NOT NULL DEFAULT ''");
  await safeAddColumn('criteria', 'proxy_url', "TEXT NOT NULL DEFAULT ''");
  await safeAddColumn('jobs', 'description', 'TEXT');
  await safeAddColumn('jobs', 'is_hardware', 'BOOLEAN NOT NULL DEFAULT false');
  await safeAddColumn('jobs', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await safeAddColumn('jobs', 'status', "TEXT NOT NULL DEFAULT 'new'");
  await safeAddColumn('jobs', 'ai_risk', "TEXT NOT NULL DEFAULT 'unknown'");
  await safeAddColumn('jobs', 'ai_risk_reason', 'TEXT');
  await safeAddColumn('jobs', 'opportunity_tier', "TEXT NOT NULL DEFAULT 'unscored'");
  await safeAddColumn('jobs', 'sub_scores', 'JSONB');
  await safeAddColumn('companies', 'scan_failures', 'INT NOT NULL DEFAULT 0');
  await safeAddColumn('companies', 'last_scan_error', 'TEXT');
  await safeAddColumn('companies', 'detect_status', "TEXT NOT NULL DEFAULT 'manual'");
  await safeAddColumn('companies', 'ats_types_tried', "TEXT[] NOT NULL DEFAULT '{}'");
  // Gemini discovery columns — added when hybrid pipeline was introduced
  await safeAddColumn('jobs', 'gemini_grounding_metadata', 'JSONB');
  await safeAddColumn('jobs', 'ingestion_confidence', 'FLOAT');

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
    ];
    let savedRow: Record<string, unknown>;
    if (existing.length === 0) {
      const { rows } = await pool.query(
        `INSERT INTO criteria (target_roles, industries, min_salary, work_type, locations, must_have, nice_to_have, avoid, your_name, your_email, remote_strict, experience_level, stretch_companies, vertical_niches, top_target_score, fast_win_score, stretch_score, allowed_work_modes, experience_levels, proxy_url, min_ote)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`, params
      );
      savedRow = rows[0];
    } else {
      const { rows } = await pool.query(
        `UPDATE criteria SET target_roles=$1, industries=$2, min_salary=$3, work_type=$4, locations=$5,
         must_have=$6, nice_to_have=$7, avoid=$8, your_name=$9, your_email=$10, remote_strict=$11,
         experience_level=$12, stretch_companies=$13, vertical_niches=$14, top_target_score=$15, fast_win_score=$16, stretch_score=$17,
         allowed_work_modes=$18, experience_levels=$19, proxy_url=$20, min_ote=$21
         WHERE id=$22 RETURNING *`, [...params, existing[0].id]
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
    // is_live: we don't have real-time liveness checks yet; null = unknown
    is_live: null,
  };
}

// Jobs
app.get('/api/jobs', async (req: Request, res: Response) => {
  try {
    const minScore = Number(req.query.min_score) || 0;
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
      `SELECT * FROM jobs WHERE match_score >= $1 ORDER BY ${sort}`,
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

// Opportunity Rescore — backfill sub-scores and tiers for existing jobs
let rescoreRunning = false;

app.get('/api/jobs/rescore-status', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query(`SELECT COUNT(*) as total, SUM(CASE WHEN opportunity_tier='unscored' THEN 1 ELSE 0 END) as unscored FROM jobs`);
    res.json({ running: rescoreRunning, total: Number(rows[0].total), unscored: Number(rows[0].unscored) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.post('/api/jobs/rescore-all', async (_req, res: Response) => {
  if (rescoreRunning) { res.json({ started: false, message: 'Rescore already running' }); return; }
  try {
    const { rows: unscored } = await pool.query(`SELECT * FROM jobs WHERE opportunity_tier='unscored' ORDER BY found_at DESC`);
    if (unscored.length === 0) { res.json({ started: false, message: 'All jobs already scored', count: 0 }); return; }
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
                `UPDATE jobs SET opportunity_tier=$1, sub_scores=$2, ai_risk=$3, ai_risk_reason=$4, why_good_fit=$5, match_score=$6 WHERE id=$7`,
                [result.opportunityTier, JSON.stringify(result.subScores), result.aiRisk, result.aiRiskReason, result.whyGoodFit, result.matchScore, j.id]
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

  // Fetch all jobs (scored or not)
  const { rows } = await pool.query(`
    SELECT id, title, company, location, salary, match_score, ai_risk, sub_scores, opportunity_tier
    FROM jobs
  `);

  // Helper: check if a stored salary string is KNOWN to be below minimum
  function salaryKnownBelow(salaryStr: string | null | undefined): boolean {
    if (!minSalary || !salaryStr) return false;
    const nums = salaryStr.match(/[\d,]+/g);
    if (!nums) return false;
    const highest = Math.max(...nums.map((n: string) => parseInt(n.replace(/,/g, ''), 10)));
    if (isNaN(highest) || highest === 0 || highest < 1000) return false; // skip hourly-looking
    return highest < minSalary;
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

      if (!titleMatches || hasAvoid || !locationOk || belowSalary) {
        tier = 'Probably Skip';
      } else if (j.sub_scores && j.match_score !== null) {
        const s: SubScores = typeof j.sub_scores === 'string' ? JSON.parse(j.sub_scores) : j.sub_scores;
        tier = computeTier(j.match_score, j.ai_risk ?? 'unknown', s, j.title, j.company, loc, tierSettings);
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
      'INSERT INTO gmail_tokens (access_token, refresh_token, expiry) VALUES ($1, $2, $3)',
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
  if (rows.length === 0) return null;
  const token = rows[0];
  // Check if expired and refresh
  if (token.expiry && new Date(token.expiry) < new Date() && token.refresh_token) {
    try {
      const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          refresh_token: token.refresh_token,
          client_id: GMAIL_CLIENT_ID,
          client_secret: GMAIL_CLIENT_SECRET,
          grant_type: 'refresh_token',
        }),
      });
      const data = await refreshRes.json() as { access_token?: string; expires_in?: number };
      if (data.access_token) {
        const expiry = data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null;
        await pool.query(
          'UPDATE gmail_tokens SET access_token=$1, expiry=$2 WHERE id=$3',
          [data.access_token, expiry, token.id]
        );
        return data.access_token;
      }
    } catch { /* fall through */ }
  }
  return token.access_token;
}

async function sendGmailEmail(to: string, subject: string, htmlBody: string): Promise<boolean> {
  const accessToken = await getGmailAccessToken();
  if (!accessToken) return false;

  const boundary = 'boundary_' + Date.now();
  const rawEmail = [
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset="UTF-8"`,
    '',
    htmlBody,
  ].join('\r\n');

  const encoded = Buffer.from(rawEmail).toString('base64url');

  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw: encoded }),
  });
  return res.ok;
}

app.post('/api/gmail/send-test', async (_req, res: Response) => {
  try {
    // Get user email from criteria
    const { rows: cRows } = await pool.query('SELECT your_email FROM criteria LIMIT 1');
    const email = cRows[0]?.your_email;
    if (!email) { res.status(400).json({ error: 'Set your email in the Criteria tab first' }); return; }

    // Get recent jobs
    const { rows: jobs } = await pool.query(
      'SELECT * FROM jobs WHERE match_score >= 50 ORDER BY match_score DESC LIMIT 10'
    );

    const html = buildDigestHtml(jobs);
    const sent = await sendGmailEmail(email, 'Job Scout Agent — Test Digest', html);
    if (sent) {
      res.json({ ok: true, message: 'Test digest sent to ' + email });
    } else {
      res.status(500).json({ error: 'Failed to send email. Make sure Gmail is connected.' });
    }
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.get('/api/gmail/preview', async (_req, res: Response) => {
  try {
    const { rows: jobs } = await pool.query(
      'SELECT * FROM jobs WHERE match_score >= 50 ORDER BY match_score DESC LIMIT 10'
    );
    res.json({ html: buildDigestHtml(jobs) });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

function buildDigestHtml(jobs: any[]): string {
  const jobCards = jobs.map(j => {
    const jobData = JSON.stringify({ title: j.title, company: j.company, location: j.location, salary: j.salary || '', score: j.match_score, why: j.why_good_fit || '', url: j.apply_url }).replace(/"/g, '&quot;');
    return `
    <div class="digest-job" data-job="${jobData}" style="background:#1a1a1a;border:1px solid #333;border-radius:8px;padding:16px;margin-bottom:12px;position:relative">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span style="color:#c8a96e;font-weight:bold;font-size:16px">${esc(j.title)}</span>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="background:#c8a96e;color:#0f0f0f;padding:2px 10px;border-radius:12px;font-weight:bold;font-size:13px">${esc(j.match_score)}/100</span>
        </div>
      </div>
      <div style="color:#999;margin:6px 0">${esc(j.company)} • ${esc(j.location)}${j.salary ? ' • ' + esc(j.salary) : ''}</div>
      <div style="color:#bbb;font-size:13px;margin:8px 0">${esc(j.why_good_fit)}</div>
      <div style="display:flex;align-items:center;gap:12px">
        <a href="${esc(j.apply_url)}" style="color:#c8a96e;font-size:13px">View Posting →</a>
      </div>
    </div>
  `;}).join('');

  return `
    <div style="background:#0f0f0f;color:#e8e6e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;padding:32px;max-width:640px;margin:0 auto">
      <div style="text-align:center;margin-bottom:24px">
        <h1 style="color:#c8a96e;font-size:22px;margin:0">⬡ Job Scout Agent — Daily Digest</h1>
        <p style="color:#666;font-size:13px;margin-top:6px">${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</p>
      </div>
      <div style="color:#999;font-size:14px;margin-bottom:16px">${jobs.length} match${jobs.length !== 1 ? 'es' : ''} found</div>
      ${jobs.length > 0 ? jobCards : '<div style="color:#666;text-align:center;padding:32px">No matches yet. Run the scout first!</div>'}
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

    const { rows: companies } = await pool.query('SELECT * FROM companies');
    console.log(`\n════════════════════════════════════════════════════════════`);
    console.log(`SCOUT RUN #${runId} — ${companies.length} companies loaded from database`);
    console.log(`════════════════════════════════════════════════════════════`);
    const byType: Record<string, number> = {};
    for (const c of companies) { byType[(c as any).ats_type] = (byType[(c as any).ats_type] || 0) + 1; }
    console.log(`  Companies by ATS type:`, byType);

    type Job = { title: string; company: string; location: string; salary?: string; applyUrl: string; description?: string; source: string; _fromJobSpy?: boolean; _fromGemini?: boolean };
    const allJobs: Job[] = [];
    // Side-map: applyUrl → per-job metadata for Gemini-sourced jobs
    const geminiMetaByUrl = new Map<string, { groundingMetadata?: object; confidence?: number }>();
    let companiesScanned = 0;
    const perCompanyStats: { name: string; type: string; jobs: number; error?: string }[] = [];

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

    // Apply all hard pre-filters
    let preFiltered = toScore;
    let droppedByLocation = 0;
    let droppedByAvoid = 0;
    let droppedBySalary = 0;

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

    console.log(`\n──── PRE-FILTERS (before Claude scoring) ───────────────────`);
    console.log(`  After title filter: ${toScore.length}`);
    console.log(`  Dropped by location: ${droppedByLocation}`);
    console.log(`  Dropped by avoid keywords: ${droppedByAvoid}`);
    console.log(`  Dropped by salary below $${criteria.min_salary?.toLocaleString() ?? 'n/a'}: ${droppedBySalary}`);
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

    // Load the candidate's resume for resume-aware scoring
    const { rows: resumeSettingRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
    const candidateResume: string = resumeSettingRows[0]?.value ?? '';

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
      }
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
      const source = newJobs.find(j => j.applyUrl === m.applyUrl)?.source ?? '';
      const loc = (m.location ?? '').trim();
      let finalTier: string;

      // Apply location check + deterministic tier logic using our computeTier
      const locationOk = checkJobLocation(loc, criteria.locations, false, allowedWorkModes);
      if (!locationOk) {
        finalTier = 'Probably Skip';
      } else if (m.subScores && m.matchScore) {
        finalTier = computeTier(m.matchScore, m.aiRisk ?? 'unknown', m.subScores, m.title, m.company, loc, tierSettings);
      } else {
        finalTier = m.opportunityTier ?? 'unscored';
      }

      // Look up Gemini-specific metadata for this job (if it came from Gemini)
      const geminiMeta = geminiMetaByUrl.get(m.applyUrl);
      await pool.query(
        `INSERT INTO jobs (scout_run_id, title, company, location, salary, apply_url, why_good_fit, match_score, source, is_hardware, ai_risk, ai_risk_reason, opportunity_tier, sub_scores, gemini_grounding_metadata, ingestion_confidence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (apply_url) DO NOTHING`,
        [runId, m.title, m.company, m.location, m.salary ?? null, m.applyUrl, m.whyGoodFit, m.matchScore, source, m.isHardware ?? false, m.aiRisk ?? 'unknown', m.aiRiskReason ?? null, finalTier, JSON.stringify(m.subScores ?? null), geminiMeta?.groundingMetadata ? JSON.stringify(geminiMeta.groundingMetadata) : null, geminiMeta?.confidence ?? null]
      );
    }

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

    // Send digest email if Gmail is connected
    try {
      const { rows: crit } = await pool.query('SELECT your_email FROM criteria LIMIT 1');
      if (crit[0]?.your_email && matches.length > 0) {
        const { rows: recentJobs } = await pool.query(
          'SELECT * FROM jobs WHERE scout_run_id=$1 ORDER BY match_score DESC', [runId]
        );
        await sendGmailEmail(
          crit[0].your_email,
          `Job Scout Agent — ${matches.length} new match${matches.length !== 1 ? 'es' : ''} found`,
          buildDigestHtml(recentJobs)
        );
      }
    } catch (emailErr) {
      console.error('Email sending failed (non-fatal):', emailErr);
    }
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

initDb()
  .then(async () => {
    // Auto-reclassify all existing jobs using current tier logic (free, no Claude)
    try {
      const n = await reclassifyJobsLocally();
      if (n > 0) console.log(`Startup reclassify: updated ${n} job tiers to match current logic`);
    } catch (e) { console.warn('Startup reclassify skipped:', e); }

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

/* layout */
.app-body{display:flex;flex:1;min-height:0}

/* sidebar */
.sidebar{width:200px;min-width:200px;border-right:1px solid var(--border);display:flex;flex-direction:column;gap:2px;padding:12px 10px;background:var(--bg)}
.sidebar .tab{padding:9px 14px;font-size:13px;color:var(--muted);cursor:pointer;border-radius:7px;user-select:none;white-space:nowrap;border-left:3px solid transparent;transition:background .12s,color .12s}
.sidebar .tab:hover{background:var(--surface);color:var(--text)}
.sidebar .tab.active{color:var(--text);background:var(--surface);border-left-color:var(--gold)}

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

/* jobs */
.jobs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px;margin-top:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.card-head{padding:16px 18px 12px;border-bottom:1px solid #1e1e1e}
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
@keyframes spin{to{transform:rotate(360deg)}}
@media(max-width:700px){.intel-cards{grid-template-columns:1fr}.intel-themes-grid{grid-template-columns:1fr}}
/* clawd iframe panel */
#panel-clawd{padding:0!important}
.clawd-frame{width:100%;height:100%;border:none;display:block}
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
</style>
</head>
<body>

<header>
  <span class="logo">&#x2B21; JSOS.ai</span>
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
</div>

<div class="app-body">
<nav class="sidebar">
  <div class="tab active" id="tab-jobs" onclick="showTab('jobs')">Jobs</div>
  <div class="tab sub-tab" id="tab-saved" onclick="showTab('saved')">&nbsp;&nbsp;Saved Jobs</div>
  <div class="tab" id="tab-research" onclick="showTab('research')">Research</div>
  <div class="tab" id="tab-intel" onclick="showTab('intel')">Career Intel</div>
  <div class="tab" id="tab-companies" onclick="showTab('companies')">Companies</div>
  <div class="tab" id="tab-resume" onclick="showTab('resume')">Resume</div>
  <div class="tab" id="tab-email" onclick="showTab('email')">Daily Jobs Report</div>
  <div class="tab" id="tab-runs" onclick="showTab('runs')">Run History</div>
  <div class="tab" id="tab-settings" onclick="showTab('settings')">Settings</div>
  <div class="tab" id="tab-clawd" onclick="showTab('clawd')">DeathByClawd</div>
</nav>
<div class="main-content">
<div class="panel active" id="panel-jobs">
  <div class="rescore-banner hidden" id="rescore-banner">
    <div>
      <div class="rescore-msg"><strong id="rescore-msg-main">Scoring your library...</strong></div>
      <div class="rescore-progress" id="rescore-progress-msg"></div>
    </div>
    <button class="btn btn-gold btn-sm" id="rescore-btn" onclick="startRescore()">Score All Jobs</button>
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
        <button class="btn btn-gold" onclick="tailorFromDesc()">Tailor Resume</button>
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
    <div class="email-toolbar">
      <button class="btn btn-gold btn-sm" id="gmail-connect-btn" onclick="connectGmail()">Connect Gmail</button>
      <button class="btn btn-red btn-sm" id="gmail-disconnect-btn" onclick="disconnectGmail()" style="display:none">Disconnect</button>
      <span id="gmail-status-text" style="font-size:11px;color:var(--muted)"></span>
      <span class="toolbar-sep"></span>
      <input type="time" id="digest-time" value="08:00" style="width:110px;padding:4px 8px;font-size:12px">
      <button class="btn btn-ghost btn-sm" onclick="saveDigestTime()">Save Time</button>
      <span class="ok-msg" id="digest-time-msg" style="display:none">Saved!</span>
      <span class="toolbar-sep"></span>
      <button class="btn btn-gold btn-sm" onclick="sendTestDigest()">Send Test Email</button>
      <span id="test-email-msg" style="font-size:11px;color:var(--muted)"></span>
    </div>
    <div class="sec-title" style="margin-bottom:8px">Daily Jobs Report</div>
    <div class="email-preview" id="email-preview">Loading preview...</div>
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
  </div>
</div>

<div class="panel" id="panel-companies">
  <div class="company-list" id="company-list"></div>
  <div class="sec-title" style="margin-bottom:12px">Add Company</div>
  <div style="font-size:12px;color:var(--muted);margin-bottom:14px">Type a company name — AI will automatically detect the job board and verify it's working.</div>
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
      <label>Vertical Niche Signals <span class="hint">(title keywords that push a role above your level — Federal, SLED, Healthcare, etc.)</span></label>
      <input type="text" id="set-niches-input" placeholder="e.g. federal, SLED, healthcare, FSI">
      <div class="tag-list" id="set-niches-tags"></div>
    </div>
  </div>

  <div class="sec-title" style="margin:24px 0 12px">Resume AI Model</div>
  <div style="font-size:12px;color:var(--muted);margin-bottom:14px;line-height:1.6">Choose which Claude model powers resume tailoring and cover letter writing. Opus produces higher-quality, more nuanced output — Sonnet is faster and still excellent.</div>
  <div style="display:flex;gap:12px;flex-wrap:wrap" id="tailor-model-btns">
    <button class="model-pick-btn" id="mpb-sonnet" onclick="setTailorModel('claude-sonnet-4-5')">
      <div style="font-size:13px;font-weight:700">Claude Sonnet</div>
      <div style="font-size:11px;color:var(--muted);margin-top:3px">Fast · Great quality · Default</div>
    </button>
    <button class="model-pick-btn" id="mpb-opus" onclick="setTailorModel('claude-opus-4-5')">
      <div style="font-size:13px;font-weight:700">Claude Opus</div>
      <div style="font-size:11px;color:var(--muted);margin-top:3px">Slower · Best quality · Recommended for final applications</div>
    </button>
  </div>
  <div id="tailor-model-msg" style="font-size:11px;color:#4ade80;margin-top:8px;display:none">Model saved.</div>

  <div class="save-row" style="margin-top:24px">
    <button class="btn btn-gold" onclick="saveCriteria()">Save Settings</button>
    <span class="ok-msg" id="settings-msg" style="display:none">Saved!</span>
  </div>
</div>

</div><!-- /main-content -->
</div><!-- /app-body -->

<!-- Tailor Resume Modal -->
<div class="modal-overlay" id="tailor-modal">
  <div class="modal" style="max-width:800px">
    <div class="modal-header">
      <div>
        <div style="font-size:16px;font-weight:600" id="tailor-title"></div>
        <div style="font-size:13px;color:var(--gold)" id="tailor-company"></div>
      </div>
      <div style="display:flex;align-items:center;gap:10px">
        <span style="font-size:11px;color:var(--muted)">Target:</span>
        <div class="page-toggle" id="modal-page-toggle">
          <button class="page-toggle-btn active" data-pages="1" onclick="setModalPageTarget(1)">1 Page</button>
          <button class="page-toggle-btn" data-pages="2" onclick="setModalPageTarget(2)">2 Pages</button>
        </div>
        <button class="btn btn-ghost btn-sm" id="retailor-btn" style="display:none" onclick="retailorResume()">↻ Re-tailor</button>
        <button class="modal-close" onclick="closeTailorModal()">&times;</button>
      </div>
    </div>
    <div id="tailor-loading" style="text-align:center;padding:32px;color:var(--muted)">Analyzing job description and tailoring resume with Claude Sonnet...</div>
    <div id="tailor-content" style="display:none">
      <div class="modal-section">
        <div id="tailor-analysis-modal" style="display:none" class="tailor-analysis"></div>
        <div style="display:flex;gap:16px">
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <h3 style="margin:0">Tailored Resume</h3>
              <div style="display:flex;gap:6px">
                <button class="btn btn-ghost btn-sm" onclick="copyRendered('tailor-resume')">Copy</button>
                <button class="btn btn-ghost btn-sm" onclick="downloadDocxFromModal('tailor-resume','Tailored_Resume')">⬇ Word</button>
                <button class="btn btn-ghost btn-sm" onclick="printResume('tailor-resume')">⬇ PDF</button>
              </div>
            </div>
            <div class="resume-rendered" id="tailor-resume" style="max-height:380px"></div>
          </div>
          <div style="flex:1;min-width:0">
            <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
              <h3 style="margin:0">Cover Letter</h3>
              <div style="display:flex;gap:6px">
                <button class="btn btn-ghost btn-sm" onclick="copyRendered('tailor-cover')">Copy</button>
                <button class="btn btn-ghost btn-sm" onclick="downloadDocxFromModal('tailor-cover','Cover_Letter')">⬇ Word</button>
                <button class="btn btn-ghost btn-sm" onclick="printResume('tailor-cover')">⬇ PDF</button>
              </div>
            </div>
            <div class="resume-rendered" id="tailor-cover" style="max-height:380px"></div>
          </div>
        </div>
        <details style="margin-top:16px;border:1px solid var(--border);border-radius:8px;padding:0 12px">
          <summary style="cursor:pointer;font-size:13px;color:var(--gold);font-weight:600;padding:12px 0;user-select:none">▸ What Changed & Why</summary>
          <div style="padding-bottom:14px">
            <div class="resume-rendered" id="tailor-edits"></div>
          </div>
        </details>
      </div>
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

<div class="panel" id="panel-clawd">
  <iframe class="clawd-frame" src="https://deathbyclawd.com/" allow="fullscreen" loading="lazy"></iframe>
</div>

<script>
// ── helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function lines(id) {
  return document.getElementById(id).value.split('\\n').map(function(s){return s.trim();}).filter(Boolean);
}

// ── tabs ─────────────────────────────────────────────────────────────────
var TABS = ['jobs','saved','research','intel','companies','resume','email','runs','settings','clawd'];
function showTab(name) {
  TABS.forEach(function(t) {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('panel-' + t).classList.toggle('active', t === name);
  });
  if (name === 'jobs')      loadJobs();
  if (name === 'saved')     loadSavedJobs();
  if (name === 'research')  loadSavedResearch();
  if (name === 'runs')      loadRuns();
  if (name === 'companies') loadCompanies();
  if (name === 'resume')    loadResume();
  if (name === 'email')     { loadGmailStatus(); loadEmailPreview(); loadDigestTime(); }
  if (name === 'settings')  loadCriteria();
  if (name === 'intel')     loadCareerIntel();
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
    var msgMain = document.getElementById('rescore-msg-main');
    var msgProg = document.getElementById('rescore-progress-msg');
    if (_rescoreUnscored > 0 || _rescoreRunning) {
      banner.classList.remove('hidden');
      if (_rescoreRunning) {
        msgMain.textContent = 'Scoring in progress\u2026';
        var done = _rescoreTotal - _rescoreUnscored;
        msgProg.textContent = done + ' of ' + _rescoreTotal + ' scored \u2014 refresh to see results';
        btn.textContent = 'Scoring\u2026';
        btn.disabled = true;
        if (!_rescore_pollTimer) _rescore_pollTimer = setInterval(function() { checkRescoreStatus(); loadJobs(); }, 8000);
      } else {
        msgMain.textContent = _rescoreUnscored + ' unscored jobs in your library';
        msgProg.textContent = 'Click "Score All Jobs" to classify them into tiers';
        btn.textContent = 'Score All Jobs';
        btn.disabled = false;
        if (_rescore_pollTimer) { clearInterval(_rescore_pollTimer); _rescore_pollTimer = null; }
      }
    } else {
      banner.classList.add('hidden');
      if (_rescore_pollTimer) { clearInterval(_rescore_pollTimer); _rescore_pollTimer = null; }
    }
  } catch(e) {}
}

async function startRescore() {
  var btn = document.getElementById('rescore-btn');
  btn.disabled = true;
  btn.textContent = 'Starting\u2026';
  try {
    var res = await fetch('/api/jobs/rescore-all', { method: 'POST' });
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

function subScoreColor(v) {
  if (v >= 8) return '#00c86e';
  if (v >= 6) return '#f5c842';
  if (v >= 4) return '#ff9f43';
  return '#e55353';
}

function subScoresHtml(j) {
  if (!j.sub_scores) return '';
  var s = typeof j.sub_scores === 'string' ? JSON.parse(j.sub_scores) : j.sub_scores;
  var dims = [
    ['roleFit','Role Fit'],['qualificationFit','Qualification'],['companyQuality','Company'],
    ['locationFit','Location'],['hiringUrgency','Hiring Urgency'],
    ['tailoringRequired','Tailoring Needed'],['referralOdds','Referral Odds'],['realVsFake','Real vs Fake']
  ];
  var rows = '';
  for (var i = 0; i < dims.length; i++) {
    var key = dims[i][0]; var label = dims[i][1];
    var v = (s[key] !== undefined && s[key] !== null) ? Number(s[key]) : 5;
    var pct = Math.round(v * 10);
    var col = subScoreColor(v);
    rows += '<div class="sub-score-row"><span class="sub-score-label">' + label + '</span><div class="sub-score-bar"><div class="sub-score-fill" style="width:' + pct + '%;background:' + col + '"></div></div><span class="sub-score-val">' + v + '</span></div>';
  }
  return '<div class="sub-scores" id="ss-' + j.id + '"><div class="sub-score-grid">' + rows + '</div></div>';
}

function toggleSubScores(id) {
  var el = document.getElementById('ss-' + id);
  if (el) el.classList.toggle('open');
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
  if (!j.found_at) return false;
  var d = new Date(j.found_at);
  var now = new Date();
  var diff = now.getTime() - d.getTime();
  return diff < 2 * 24 * 60 * 60 * 1000; // 2 days
}

function jobAge(j) {
  if (!j.found_at) return '';
  var d = new Date(j.found_at);
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
  var barColor = j.match_score >= 80 ? 'var(--green)' : j.match_score >= 50 ? 'var(--gold)' : 'var(--red)';
  var isSaved = !!j.saved_at;
  var newBadge = (opts.showNew && isNew(j)) ? '<span class="new-badge">NEW</span>' : '';
  var savedDate = (opts.showSavedDate && j.saved_at) ? '<div class="saved-date">Saved ' + new Date(j.saved_at).toLocaleDateString() + '</div>' : '';
  var saveLabel = isSaved ? 'Saved' : 'Save';
  var saveClass = isSaved ? 'save-btn saved' : 'save-btn';

  // Salary display logic
  var salaryHtml = '';
  if (j.salary && j.salary !== 'Unknown' && j.salary !== 'N/A' && j.salary.trim() !== '') {
    salaryHtml = '<span style="color:var(--green)">\\uD83D\\uDCB0 ' + esc(j.salary) + '</span>';
  } else if (j.salary_estimate) {
    salaryHtml = formatSalaryEstimate(typeof j.salary_estimate === 'string' ? JSON.parse(j.salary_estimate) : j.salary_estimate);
  }

  var repvueBadge = renderRepVueBadge(j);

  var aiRiskBadge = '';
  if (j.ai_risk && j.ai_risk !== 'unknown') {
    var riskLabel = j.ai_risk === 'LOW' ? '\\u2705 AI Safe' : j.ai_risk === 'MEDIUM' ? '\\u26A0\\uFE0F AI Medium' : '\\u26D4 AI Risk';
    var riskTitle = j.ai_risk_reason ? esc(j.ai_risk_reason) : '';
    aiRiskBadge = '<span class="ai-risk-badge ai-risk-' + esc(j.ai_risk) + '" title="' + riskTitle + '">' + riskLabel + '</span>';
  }

  var tierClass = tierCssClass(j);
  var tBadge = tierBadgeHtml(j);
  var ssHtml = subScoresHtml(j);
  var ssToggle = j.sub_scores ? '<button class="sub-score-toggle" onclick="toggleSubScores(' + j.id + ')">Scoring Details</button>' : '';
  var territoryBadge = isRemoteInTerritory(j.location) ? '<span style="display:inline-flex;align-items:center;gap:3px;padding:2px 7px;border-radius:4px;font-size:10px;font-weight:600;background:rgba(255,159,67,.12);color:#ff9f43;border:1px solid rgba(255,159,67,.3)" title="This job requires you to live near the listed city, not work from anywhere.">&#x26A0; Territory</span>' : '';

  return '<div class="card ' + tierClass + '">' +
    '<div class="card-head">' +
      '<div class="score-row">' +
        '<span style="display:flex;align-items:center;gap:8px">' + (tBadge || '<span style="color:var(--muted);font-size:11px">Unscored</span>') + '</span>' +
        '<span class="score-val">' + esc(j.match_score) + ' / 100</span>' +
      '</div>' +
      '<div class="bar-bg"><div class="bar-fg" style="width:' + esc(j.match_score) + '%;background:' + barColor + '"></div></div>' +
      '<div class="job-title">' + esc(j.title) + newBadge + '</div>' +
      '<div class="job-co">' + esc(j.company) + '</div>' +
      savedDate +
    '</div>' +
    '<div class="card-meta">' +
      '<span>\\uD83D\\uDCCD ' + esc(j.location) + '</span>' +
      salaryHtml +
      aiRiskBadge +
      territoryBadge +
      repvueBadge +
      (j.source ? '<span class="source-badge" data-src="' + esc(j.source) + '">' + esc(j.source) + '</span>' : '') +
      (jobAge(j) ? '<span class="age-badge">' + jobAge(j) + '</span>' : '') +
      ssToggle +
    '</div>' +
    ssHtml +
    (j.why_good_fit ? '<div class="card-why">' + esc(j.why_good_fit) + '</div>' : '') +
    '<div class="card-foot">' +
      '<a href="' + esc(j.apply_url) + '" target="_blank" rel="noopener" class="btn btn-gold btn-sm">View Posting \\u2192</a>' +
      '<button class="btn btn-ghost btn-sm" onclick="tailorResume(' + j.id + ')">Tailor Resume</button>' +
      '<button class="btn btn-ghost btn-sm" id="research-btn-' + j.id + '" onclick="researchCompany(' + j.id + ')">\\uD83D\\uDD0D Research Company</button>' +
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
    jobs = _allJobs.slice().sort(function(a, b) { return b.match_score - a.match_score; });
    cnt.textContent = jobs.length + ' job' + (jobs.length !== 1 ? 's' : '') + ' total';
  } else {
    var tierMap = { target:'Top Target', win:'Fast Win', stretch:'Stretch Role', skip:'Probably Skip' };
    var tierLabel = tierMap[_currentJobsTab];
    jobs = _allJobs.filter(function(j) { return tierKey(j) === _currentJobsTab; }).sort(function(a,b) { return b.match_score - a.match_score; });
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

async function loadJobs() {
  try {
    var res = await fetch('/api/jobs?min_score=50');
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
var _modalPageTarget = 1;
var _currentTailorJobId = null;

function setPageTarget(n) {
  _inlinePageTarget = n;
  document.querySelectorAll('#page-toggle .page-toggle-btn').forEach(function(b) {
    b.classList.toggle('active', Number(b.dataset.pages) === n);
  });
}
function setModalPageTarget(n) {
  _modalPageTarget = n;
  document.querySelectorAll('#modal-page-toggle .page-toggle-btn').forEach(function(b) {
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

// ── tailor resume modal ───────────────────────────────────────────────────
function closeTailorModal() {
  document.getElementById('tailor-modal').classList.remove('show');
  _currentTailorJobId = null;
}
function copyText(id) {
  var text = document.getElementById(id).innerText;
  navigator.clipboard.writeText(text);
}

async function doTailorJob(jobId, force) {
  document.getElementById('tailor-loading').style.display = '';
  document.getElementById('tailor-loading').textContent = 'Analyzing job description and tailoring resume with Claude Sonnet (' + _modalPageTarget + '-page target)...';
  document.getElementById('tailor-content').style.display = 'none';
  document.getElementById('tailor-analysis-modal').style.display = 'none';
  document.getElementById('retailor-btn').style.display = 'none';
  try {
    var payload = { targetPages: _modalPageTarget, force: !!force };
    var res = await fetch('/api/tailor/' + jobId, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
    var data = await res.json();
    if (data.error) {
      document.getElementById('tailor-loading').textContent = 'Error: ' + data.error;
      return;
    }
    setRendered('tailor-resume', data.resume_text || '');
    setRendered('tailor-cover', data.cover_letter || '');
    setRendered('tailor-edits', data.suggested_edits || '');
    if (data.analysis) renderAnalysis('tailor-analysis-modal', data.analysis);
    document.getElementById('tailor-loading').style.display = 'none';
    document.getElementById('tailor-content').style.display = '';
    document.getElementById('retailor-btn').style.display = '';
  } catch(e) {
    document.getElementById('tailor-loading').textContent = 'Error: ' + e.message;
  }
}

async function tailorResume(jobId) {
  _currentTailorJobId = jobId;
  var j = _jobsById[jobId] || {};
  document.getElementById('tailor-title').textContent = j.title || '';
  document.getElementById('tailor-company').textContent = j.company || '';
  document.getElementById('tailor-modal').classList.add('show');
  await doTailorJob(jobId, false);
}

async function retailorResume() {
  if (!_currentTailorJobId) return;
  await doTailorJob(_currentTailorJobId, true);
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
      badge.textContent = 'Gmail: Connected';
      badge.className = 'gmail-badge on';
      connectBtn.style.display = 'none';
      disconnectBtn.style.display = '';
      statusText.textContent = 'Connected ' + (data.connectedAt ? new Date(data.connectedAt).toLocaleDateString() : '');
    } else {
      badge.textContent = 'Gmail: Not Connected';
      badge.className = 'gmail-badge off';
      connectBtn.style.display = '';
      disconnectBtn.style.display = 'none';
      statusText.textContent = '';
    }
  } catch(e) {}
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
  var res = await fetch('/api/companies');
  var cos = await res.json();
  var list = document.getElementById('company-list');
  if (!cos.length) { list.innerHTML = '<div class="empty">No companies yet — add one below.</div>'; return; }
  var html = '';
  cos.forEach(function(c) {
    var detail = c.ats_slug || c.careers_url || '';
    var status = c.detect_status || 'manual';
    var statusColor = status === 'detected' ? 'var(--green)' : status === 'pending' ? '#f5a623' : status === 'failed' ? 'var(--red)' : 'var(--muted)';
    var statusLabel = status === 'detected' ? '✓ verified' : status === 'pending' ? '⏳ pending' : status === 'failed' ? '✗ failed' : '';
    var atsLabel = c.ats_type ? c.ats_type.charAt(0).toUpperCase() + c.ats_type.slice(1) : '';
    var errorHtml = (status === 'failed' || status === 'pending') && c.last_scan_error
      ? '<div style="font-size:11px;color:var(--muted);margin-top:3px;white-space:normal">' + esc(c.last_scan_error.slice(0, 120)) + (c.last_scan_error.length > 120 ? '…' : '') + '</div>'
      : '';
    html +=
      '<div class="company-row" style="flex-wrap:wrap;gap:4px">' +
        '<span class="company-name" style="flex:1;min-width:120px">' + esc(c.name) + '</span>' +
        '<span class="source-badge">' + esc(atsLabel) + '</span>' +
        (detail ? '<span class="company-meta" style="font-size:11px">' + esc(detail) + '</span>' : '') +
        (statusLabel ? '<span style="font-size:11px;color:' + statusColor + ';font-weight:600">' + statusLabel + '</span>' : '') +
        '<button class="btn btn-ghost btn-sm" style="margin-left:auto" onclick="retryDetect(' + c.id + ',' + JSON.stringify(c.name) + ')" title="Re-run auto-detection">↻</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="deleteCompany(' + c.id + ')">Remove</button>' +
        (errorHtml ? '<div style="width:100%;padding-left:4px">' + errorHtml + '</div>' : '') +
      '</div>';
  });
  list.innerHTML = html;
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

// ── run scout ─────────────────────────────────────────────────────────────
var pollTimer = null;
async function runScout() {
  var btn = document.getElementById('run-btn');
  var msg = document.getElementById('run-msg');
  btn.disabled = true;
  msg.textContent = 'Starting\\u2026';
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
  msg.textContent = 'Scraping job boards and scoring with Claude\\u2026';
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async function() {
    try {
      var r = await fetch('/api/scout/status');
      var runs = await r.json();
      var latest = runs[0];
      if (!latest) return;
      if (latest.status !== 'running') {
        clearInterval(pollTimer); pollTimer = null;
        btn.disabled = false;
        document.getElementById('dot').className = 'dot';
        _jobsRetries = 0;
        loadStats();
        if (latest.status === 'completed') {
          var found = latest.matches_found || latest.jobs_found;
          msg.textContent = 'Done! Found ' + found + ' new match' + (found !== 1 ? 'es' : '') + ' this run';
          loadJobs().then(function() {
            if (_allJobs.length > found) {
              msg.textContent = 'Done! Found ' + found + ' new match' + (found !== 1 ? 'es' : '') + ' (' + _allJobs.length + ' total)';
            }
          });
        } else {
          msg.textContent = 'Run failed: ' + (latest.error || 'unknown error');
        }
      }
    } catch(e) {}
  }, 3000);
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
async function setTailorModel(model) {
  await fetch('/api/settings/tailor_model', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({value:model}) });
  document.querySelectorAll('.model-pick-btn').forEach(function(b){ b.classList.remove('active'); });
  var id = model === 'claude-opus-4-5' ? 'mpb-opus' : 'mpb-sonnet';
  var btn = document.getElementById(id);
  if (btn) btn.classList.add('active');
  var msg = document.getElementById('tailor-model-msg');
  msg.style.display = '';
  setTimeout(function(){ msg.style.display = 'none'; }, 2000);
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
    // Load saved tailor model and highlight the correct button
    try {
      var mr = await fetch('/api/settings/tailor_model');
      var md = await mr.json();
      var savedModel = md.value || 'claude-sonnet-4-5';
      document.querySelectorAll('.model-pick-btn').forEach(function(b){ b.classList.remove('active'); });
      var activeId = savedModel === 'claude-opus-4-5' ? 'mpb-opus' : 'mpb-sonnet';
      var activeBtn = document.getElementById(activeId);
      if (activeBtn) activeBtn.classList.add('active');
    } catch(e2) {
      var fb = document.getElementById('mpb-sonnet');
      if (fb) fb.classList.add('active');
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
    proxy_url: (document.getElementById('set-proxy-url').value || '').trim()
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
  var tabNames = ['interview','overview','market','sales','news'];
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

// ── init ──────────────────────────────────────────────────────────────────
loadJobs();
loadStats();
loadGmailStatus();
loadCriteria();  // always load settings from DB on page load so they survive refresh/redeploy
</script>
</body>
</html>`;

// suppress TS "unused" warning
void esc;
