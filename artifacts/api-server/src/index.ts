import express, { type Request, type Response } from 'express';
import pg from 'pg';
import { scrapeGreenhouseJobs, scrapeLeverJobs, runJobSpyScraper } from './scraper.js';
import type { ScrapedJob } from './scraper.js';
import { scoreJobsWithClaude, tailorResumeWithClaude, researchCompanyWithClaude, filterUnsafeCompanies } from './agent.js';
import { estimateSalary, type SalaryEstimate } from './lib/salary.js';
// Lazy import repvue to avoid crashing if playwright browsers aren't installed
const loadRepVue = () => import('./lib/repvue.js').then(m => m.scrapeRepVue).catch(() => null);

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT) || 8080;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json({ limit: '2mb' }));

// ── Health check — MUST be the very first route for Replit ────────────────
app.get('/health', (_req, res) => { res.status(200).json({ status: 'ok' }); });
app.get('/api/healthz', (_req, res) => { res.status(200).json({ status: 'ok' }); });

// ── Gmail OAuth config ───────────────────────────────────────────────────
const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || '1007930505834-cpp1veqs8alu56k810qd2mru61keej3j.apps.googleusercontent.com';
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || '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';
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || 'https://c12ad21f-8216-45ab-b03f-5e735925225d-00-34c2t5oabpvff.riker.replit.dev/api/gmail/callback';

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
  `);

  // Add columns if they don't exist (for existing installs)
  const safeAddColumn = async (table: string, col: string, type: string) => {
    try { await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${col} ${type}`); } catch { /* ignore */ }
  };
  await safeAddColumn('research_briefs', 'saved', 'BOOLEAN NOT NULL DEFAULT false');
  await safeAddColumn('research_briefs', 'status', "TEXT NOT NULL DEFAULT 'ready'");
  await safeAddColumn('research_briefs', 'error', 'TEXT');
  await safeAddColumn('criteria', 'work_type', "TEXT NOT NULL DEFAULT 'any'");
  await safeAddColumn('jobs', 'saved_at', 'TIMESTAMPTZ');
  await safeAddColumn('scout_runs', 'companies_scanned', 'INT NOT NULL DEFAULT 0');
  await safeAddColumn('scout_runs', 'matches_found', 'INT NOT NULL DEFAULT 0');
  await safeAddColumn('jobs', 'source', "TEXT NOT NULL DEFAULT ''");
  await safeAddColumn('jobs', 'description', 'TEXT');
  await safeAddColumn('jobs', 'is_hardware', 'BOOLEAN NOT NULL DEFAULT false');
  await safeAddColumn('jobs', 'created_at', 'TIMESTAMPTZ NOT NULL DEFAULT NOW()');
  await safeAddColumn('jobs', 'status', "TEXT NOT NULL DEFAULT 'new'");

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
        ['Enterprise Account Executive', 'Strategic Account Executive', 'Senior Account Executive', 'Regional Sales Manager', 'Named Account Executive', 'sales account executive', 'sales executive', 'senior sales executive', 'sr. sales executive', 'mid market account executive', 'mid-market account executive', 'account manager', 'Enterprise account manager', 'senior account manager', 'sr. account manager', 'strategic account manager'],
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
    const { target_roles, industries, min_salary, work_type, locations, must_have, nice_to_have, avoid, your_name, your_email } = req.body;
    const { rows: existing } = await pool.query('SELECT id FROM criteria LIMIT 1');
    const params = [
      target_roles ?? [], industries ?? [], min_salary ?? null, work_type ?? 'any', locations ?? [],
      must_have ?? [], nice_to_have ?? [], avoid ?? [], your_name ?? '', your_email ?? '',
    ];
    if (existing.length === 0) {
      const { rows } = await pool.query(
        `INSERT INTO criteria (target_roles, industries, min_salary, work_type, locations, must_have, nice_to_have, avoid, your_name, your_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, params
      );
      res.json(rows[0]);
    } else {
      const { rows } = await pool.query(
        `UPDATE criteria SET target_roles=$1, industries=$2, min_salary=$3, work_type=$4, locations=$5,
         must_have=$6, nice_to_have=$7, avoid=$8, your_name=$9, your_email=$10
         WHERE id=$11 RETURNING *`, [...params, existing[0].id]
      );
      res.json(rows[0]);
    }
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

// Jobs
app.get('/api/jobs', async (req: Request, res: Response) => {
  try {
    const minScore = Number(req.query.min_score) || 0;
    const { rows } = await pool.query(
      'SELECT * FROM jobs WHERE match_score >= $1 ORDER BY match_score DESC, created_at DESC',
      [minScore]
    );

    // Attach salary estimates for jobs missing salary
    const jobsNeedingEstimate = rows.filter((j: Record<string, unknown>) => !j.salary || j.salary === 'Unknown' || j.salary === 'N/A' || (j.salary as string).trim() === '');
    if (jobsNeedingEstimate.length > 0) {
      for (const j of jobsNeedingEstimate) {
        const { rows: est } = await pool.query(
          `SELECT estimate_json FROM salary_estimates WHERE LOWER(job_title) = LOWER($1) AND LOWER(company_name) = LOWER($2) AND created_at > NOW() - INTERVAL '7 days' ORDER BY created_at DESC LIMIT 1`,
          [j.title, j.company]
        );
        if (est.length > 0) {
          (j as Record<string, unknown>).salary_estimate = est[0].estimate_json;
        }
      }
    }

    res.json(rows);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Save / unsave jobs
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
    const { rows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
    res.json({ resume: rows[0]?.value ?? '' });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

app.put('/api/resume', async (req: Request, res: Response) => {
  try {
    const { resume } = req.body;
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ('resume', $1)
       ON CONFLICT (key) DO UPDATE SET value=$1`,
      [resume ?? '']
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Resume tailoring
app.post('/api/tailor/:jobId', async (req: Request, res: Response) => {
  try {
    const jobId = Number(req.params.jobId);
    // Check if we already have a tailored doc
    const { rows: existing } = await pool.query(
      'SELECT * FROM tailored_docs WHERE job_id=$1 ORDER BY created_at DESC LIMIT 1', [jobId]
    );
    if (existing.length > 0) {
      res.json(existing[0]);
      return;
    }
    // Get job details
    const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [jobId]);
    if (jobRows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = jobRows[0];
    // Get resume
    const { rows: resRows } = await pool.query("SELECT value FROM settings WHERE key='resume'");
    const resume = resRows[0]?.value ?? '';
    if (!resume) { res.status(400).json({ error: 'No base resume saved. Please save your resume first.' }); return; }

    const result = await tailorResumeWithClaude(job, resume);
    const { rows: inserted } = await pool.query(
      `INSERT INTO tailored_docs (job_id, resume_text, cover_letter) VALUES ($1, $2, $3) RETURNING *`,
      [jobId, result.resume, result.coverLetter]
    );
    res.json(inserted[0]);
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

// Freeform resume tailoring (from pasted job description)
app.post('/api/tailor-freeform', async (req: Request, res: Response) => {
  try {
    const { resume, jobDescription } = req.body;
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
    const result = await tailorResumeWithClaude(fakeJob, resume);
    res.json({ resume_text: result.resume, cover_letter: result.coverLetter });
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

// ── RepVue ──────────────────────────────────────────────────────────────
app.get('/api/repvue/:companyName', async (req: Request, res: Response) => {
  try {
    const companyName = req.params.companyName;

    // Check cache (3-day validity)
    const { rows: cached } = await pool.query(
      `SELECT * FROM repvue_cache WHERE LOWER(company_name) = LOWER($1) AND created_at > NOW() - INTERVAL '3 days' ORDER BY created_at DESC LIMIT 1`,
      [companyName]
    );
    if (cached.length > 0) {
      res.json({ data: cached[0].data_json, cached: true });
      return;
    }

    // Scrape on demand (lazy-load playwright)
    const scrapeRepVueFn = await loadRepVue();
    if (!scrapeRepVueFn) { res.json({ data: null }); return; }
    const data = await scrapeRepVueFn(companyName);
    if (!data) {
      res.json({ data: null });
      return;
    }

    await pool.query(
      `INSERT INTO repvue_cache (company_name, data_json) VALUES ($1, $2)`,
      [companyName, JSON.stringify(data)]
    );
    res.json({ data, cached: false });
  } catch (e) { res.status(500).json({ error: String(e) }); }
});

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

function buildTitleFilter(targetRoles: string[]): RegExp | null {
  if (!targetRoles || targetRoles.length === 0) return null;
  // Build a regex that matches any of the target role keywords in the title.
  // Match full multi-word phrases AND individual significant keywords (3+ chars).
  const patterns = targetRoles.map(role => {
    const words = role.trim().split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return words.join('\\s+');
  });
  // Also extract individual keywords (3+ chars, skip common filler words) for broader matching
  const fillerWords = new Set(['the', 'and', 'for', 'senior', 'junior', 'lead', 'staff', 'principal', 'vice', 'president', 'head']);
  const keywords = new Set<string>();
  for (const role of targetRoles) {
    for (const word of role.trim().split(/\s+/)) {
      const w = word.toLowerCase();
      if (w.length >= 3 && !fillerWords.has(w)) {
        keywords.add(word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      }
    }
  }
  // Combine: match either the full phrase or any significant keyword
  const allPatterns = [...patterns, ...keywords];
  return new RegExp(`\\b(${allPatterns.join('|')})\\b`, 'i');
}

async function runScoutInBackground(runId: number): Promise<void> {
  try {
    const { rows: cRows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    if (cRows.length === 0) {
      await pool.query("UPDATE scout_runs SET status='failed', error='No criteria configured', completed_at=NOW() WHERE id=$1", [runId]);
      return;
    }
    const criteria = cRows[0] as {
      target_roles: string[]; industries: string[]; min_salary: number | null;
      locations: string[]; must_have: string[]; nice_to_have: string[]; avoid: string[];
    };

    const { rows: companies } = await pool.query('SELECT * FROM companies');
    console.log(`\n════════════════════════════════════════════════════════════`);
    console.log(`SCOUT RUN #${runId} — ${companies.length} companies loaded from database`);
    console.log(`════════════════════════════════════════════════════════════`);
    const byType: Record<string, number> = {};
    for (const c of companies) { byType[(c as any).ats_type] = (byType[(c as any).ats_type] || 0) + 1; }
    console.log(`  Companies by ATS type:`, byType);

    type Job = { title: string; company: string; location: string; salary?: string; applyUrl: string; description?: string; source: string };
    const allJobs: Job[] = [];
    let companiesScanned = 0;
    const perCompanyStats: { name: string; type: string; jobs: number; error?: string }[] = [];

    // ── Stage 2a: Scrape Greenhouse and Lever (direct API scrapers that work) ──
    for (const c of companies) {
      const co = c as { name: string; ats_type: string; ats_slug: string | null; careers_url: string | null };
      try {
        let jobCount = 0;
        if (co.ats_type === 'greenhouse' && co.ats_slug) {
          const jobs = await scrapeGreenhouseJobs(co.ats_slug, co.name);
          jobCount = jobs.length;
          allJobs.push(...jobs.map(j => ({ ...j, source: 'Greenhouse' })));
        } else if (co.ats_type === 'lever' && co.ats_slug) {
          const jobs = await scrapeLeverJobs(co.ats_slug, co.name);
          jobCount = jobs.length;
          allJobs.push(...jobs.map(j => ({ ...j, source: 'Lever' })));
        }
        // Skip workday and plain — replaced by JobSpy below
        if (co.ats_type === 'greenhouse' || co.ats_type === 'lever') {
          perCompanyStats.push({ name: co.name, type: co.ats_type, jobs: jobCount });
        }
        companiesScanned++;
      } catch (e) {
        const errMsg = e instanceof Error ? e.message : String(e);
        perCompanyStats.push({ name: co.name, type: co.ats_type, jobs: 0, error: errMsg });
        console.error(`Error scraping ${co.name}:`, e);
        companiesScanned++;
      }
    }

    // ── Stage 2b: JobSpy — scrape LinkedIn, Indeed, Glassdoor via Python ──
    try {
      const jobSpyResults = await runJobSpyScraper();
      console.log(`JobSpy returned ${jobSpyResults.length} jobs — adding all to pipeline`);
      allJobs.push(...jobSpyResults.map(j => ({ ...j, source: 'JobSpy' })));
    } catch (e) {
      console.error(`JobSpy scraper error:`, e);
    }

    // ── Stage 2c: Filter out unsafe companies from JobSpy results ──
    const companyNames = companies.map((c: any) => c.name as string);
    const jobSpyJobs = allJobs.filter(j => j.source === 'JobSpy');
    const nonJobSpyJobs = allJobs.filter(j => j.source !== 'JobSpy');
    if (jobSpyJobs.length > 0) {
      const safeJobSpyJobs = await filterUnsafeCompanies(
        jobSpyJobs.map(j => ({ title: j.title, company: j.company, location: j.location, salary: j.salary, applyUrl: j.applyUrl, description: j.description })),
        companyNames
      );
      const filteredOut = jobSpyJobs.length - safeJobSpyJobs.length;
      console.log(`Company safety filter: ${jobSpyJobs.length} JobSpy jobs → ${safeJobSpyJobs.length} passed (${filteredOut} filtered out)`);
      // Rebuild allJobs with filtered JobSpy results
      allJobs.length = 0;
      allJobs.push(...nonJobSpyJobs);
      allJobs.push(...safeJobSpyJobs.map(j => ({ ...j, source: 'JobSpy' })));
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
    const locationAllowTerms = new Set<string>();
    let allowRemote = false;
    let allowUnitedStates = false;
    if (hasLocationPrefs) {
      for (const loc of criteria.locations) {
        const lower = loc.trim().toLowerCase();
        if (lower === 'remote') { allowRemote = true; continue; }
        if (lower === 'united states') { allowUnitedStates = true; continue; }
        locationAllowTerms.add(lower);
      }
    }

    const locationAllowPattern = locationAllowTerms.size > 0
      ? new RegExp(`\\b(${Array.from(locationAllowTerms).map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'i')
      : null;

    function jobMatchesLocation(jobLocation: string): boolean {
      if (!hasLocationPrefs) return true; // no prefs = accept all
      const loc = jobLocation.trim();
      // "Remote" in job listing matches if user allows remote or united states
      if (/remote/i.test(loc) && (allowRemote || allowUnitedStates)) return true;
      // "United States" in job listing matches if user allows united states
      if (/united states/i.test(loc) && allowUnitedStates) return true;
      // Check against specific location terms
      if (locationAllowPattern && locationAllowPattern.test(loc)) return true;
      return false;
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

    if (preFiltered.length === 0) {
      await pool.query(
        "UPDATE scout_runs SET status='completed', companies_scanned=$1, jobs_found=0, matches_found=0, completed_at=NOW() WHERE id=$2",
        [companiesScanned, runId]
      );
      return;
    }

    // Pass pre-approved company names from the database to Claude scoring
    const matches = await scoreJobsWithClaude(
      preFiltered.map(j => ({ title: j.title, company: j.company, location: j.location, salary: j.salary, applyUrl: j.applyUrl, description: j.description })),
      {
        targetRoles: criteria.target_roles,
        industries: criteria.industries,
        minSalary: criteria.min_salary,
        locations: criteria.locations,
        mustHave: criteria.must_have,
        niceToHave: criteria.nice_to_have,
        avoid: criteria.avoid,
        preApprovedCompanies: companyNames,
      }
    );

    console.log(`\n──── CLAUDE SCORING RESULTS ────────────────────────────────`);
    console.log(`Claude returned ${matches.length} matches from ${preFiltered.length} candidates`);
    if (matches.length > 0) {
      const matchesByCompany: Record<string, number> = {};
      for (const m of matches) matchesByCompany[m.company] = (matchesByCompany[m.company] || 0) + 1;
      console.log(`  Matches by company:`);
      for (const [co, count] of Object.entries(matchesByCompany)) console.log(`    ✓ ${co}: ${count} (scores: ${matches.filter(m=>m.company===co).map(m=>m.matchScore).join(', ')})`);
    }
    console.log(`───────────────────────────────────────────────────────────`);

    for (const m of matches) {
      const source = preFiltered.find(j => j.applyUrl === m.applyUrl)?.source ?? '';
      await pool.query(
        `INSERT INTO jobs (scout_run_id, title, company, location, salary, apply_url, why_good_fit, match_score, source, is_hardware)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (apply_url) DO UPDATE SET
           scout_run_id = EXCLUDED.scout_run_id,
           match_score = EXCLUDED.match_score,
           why_good_fit = EXCLUDED.why_good_fit,
           created_at = NOW()`,
        [runId, m.title, m.company, m.location, m.salary ?? null, m.applyUrl, m.whyGoodFit, m.matchScore, source, m.isHardware ?? false]
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

    console.log(`════════════════════════════════════════════════════════════`);
    console.log(`SCOUT RUN #${runId} COMPLETE`);
    console.log(`  Companies scanned: ${companiesScanned}`);
    console.log(`  Raw jobs scraped:  ${allJobs.length}`);
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

function serveHTML(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(HTML);
}

app.get('/', serveHTML);
app.get('/index.html', serveHTML);

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// ── Start server ──────────────────────────────────────────────────────────

initDb()
  .then(() => {
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
.inner-tabs{display:flex;gap:0;border-bottom:1px solid var(--border);margin-bottom:16px}
.inner-tab{padding:10px 20px;font-size:13px;font-weight:600;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;transition:color .12s}
.inner-tab:hover{color:var(--text)}
.inner-tab.active{color:var(--gold);border-bottom-color:var(--gold)}
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
.age-badge{display:inline-block;padding:1px 7px;border-radius:4px;font-size:10px;font-weight:500;background:transparent;color:var(--muted);border:1px solid #333}
.salary-estimated{color:#d4a843;font-size:12px}
.salary-estimated .est-prefix{opacity:0.7;font-size:10px}
.salary-tooltip{position:relative;cursor:help}
.salary-tooltip .tooltip-text{visibility:hidden;position:absolute;bottom:120%;left:50%;transform:translateX(-50%);background:#222;color:#ccc;padding:6px 10px;border-radius:6px;font-size:11px;white-space:nowrap;z-index:10;border:1px solid #333}
.salary-tooltip:hover .tooltip-text{visibility:visible}
.repvue-badge{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;background:#1a1a2e;border:1px solid #333;color:#7c8dff;cursor:pointer;position:relative}
.repvue-badge .rv-dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.rv-green{background:#22c55e}
.rv-yellow{background:#eab308}
.rv-red{background:#ef4444}
.repvue-popover{display:none;position:absolute;top:100%;left:0;margin-top:6px;background:#1a1a2e;border:1px solid #333;border-radius:8px;padding:12px 16px;z-index:100;width:300px;font-size:12px;color:#ccc;box-shadow:0 8px 24px rgba(0,0,0,0.5)}
.repvue-popover.show{display:block}
.repvue-popover h4{margin:0 0 8px;font-size:13px;color:#7c8dff}
.repvue-popover .rv-row{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid #222}
.repvue-popover .rv-row:last-child{border-bottom:none}
.repvue-popover .rv-label{color:var(--muted)}
.repvue-popover .rv-val{font-weight:600;color:#eee}
.repvue-popover .rv-reviews{margin-top:8px;font-size:11px;color:#999;max-height:120px;overflow-y:auto}
.repvue-popover .rv-review{padding:4px 0;border-bottom:1px solid #1e1e1e}

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
  <span class="logo">&#x2B21; Job Scout Agent</span>
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
  <div class="tab" id="tab-companies" onclick="showTab('companies')">Companies</div>
  <div class="tab" id="tab-resume" onclick="showTab('resume')">Resume</div>
  <div class="tab" id="tab-email" onclick="showTab('email')">Daily Jobs Report</div>
  <div class="tab" id="tab-runs" onclick="showTab('runs')">Run History</div>
  <div class="tab" id="tab-settings" onclick="showTab('settings')">Settings</div>
</nav>
<div class="main-content">
<div class="panel active" id="panel-jobs">
  <div class="inner-tabs">
    <div class="inner-tab active" id="jtab-top" onclick="showJobsTab('top')">Top Matches</div>
    <div class="inner-tab" id="jtab-recent" onclick="showJobsTab('recent')">Recent Listings</div>
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
  <div class="resume-split">
    <div class="resume-col">
      <div class="sec-title" style="margin-bottom:8px">Base Resume</div>
      <textarea id="resume-text" rows="20" placeholder="Paste your full resume here..."></textarea>
      <div class="save-row">
        <button class="btn btn-gold btn-sm" onclick="saveResume()">Save Resume</button>
        <span class="ok-msg" id="resume-msg" style="display:none">Saved!</span>
      </div>
    </div>
    <div class="resume-col">
      <div class="sec-title" style="margin-bottom:8px">Job Description</div>
      <textarea id="job-desc-text" rows="20" placeholder="Paste the job listing description here..."></textarea>
      <div class="save-row">
        <button class="btn btn-gold" onclick="tailorFromDesc()">Tailor Resume</button>
        <span id="tailor-inline-msg" style="font-size:12px;color:var(--muted)"></span>
      </div>
    </div>
  </div>
  <div id="tailor-result" style="display:none;margin-top:24px">
    <div class="resume-split">
      <div class="resume-col">
        <div class="sec-title" style="margin-bottom:8px">Tailored Resume</div>
        <div class="modal-text" id="tailor-result-resume" style="max-height:500px"></div>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="copyText('tailor-result-resume')">Copy Resume</button>
      </div>
      <div class="resume-col">
        <div class="sec-title" style="margin-bottom:8px">Cover Letter</div>
        <div class="modal-text" id="tailor-result-cover" style="max-height:500px"></div>
        <button class="btn btn-ghost btn-sm" style="margin-top:8px" onclick="copyText('tailor-result-cover')">Copy Cover Letter</button>
      </div>
    </div>
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

<div class="panel" id="panel-companies">
  <div class="company-list" id="company-list"></div>
  <div class="sec-title" style="margin-bottom:12px">Add Company</div>
  <div class="add-form">
    <div class="fg"><label>Company Name</label><input type="text" id="co-name" placeholder="Acme Corp"></div>
    <div class="fg">
      <label>ATS Type</label>
      <select id="co-type">
        <option value="greenhouse">Greenhouse</option>
        <option value="lever">Lever</option>
        <option value="workday">Workday</option>
        <option value="plain">Plain URL</option>
      </select>
    </div>
    <div class="fg"><label>Slug / Domain / URL</label><input type="text" id="co-slug" placeholder="companyname or domain"></div>
  </div>
  <div style="margin-top:12px">
    <button class="btn btn-gold" onclick="addCompany()">Add Company</button>
  </div>
</div>
<div class="panel" id="panel-settings">
  <div class="sec-title" style="margin-bottom:16px">Search Criteria</div>
  <div class="settings-grid">
    <div class="fg">
      <label>Minimum Base Pay</label>
      <div class="input-prefix"><span>$</span><input type="number" id="set-salary" placeholder="150000" step="5000"></div>
    </div>
    <div class="fg">
      <label>Work Type</label>
      <select id="set-worktype">
        <option value="any">Any</option>
        <option value="remote">Remote</option>
        <option value="office">Office / On-site</option>
        <option value="hybrid">Hybrid</option>
      </select>
    </div>
    <div class="fg full">
      <label>Locations <span class="hint">(press Enter to add)</span></label>
      <input type="text" id="set-loc-input" placeholder="e.g. New York, Remote, Austin TX">
      <div class="tag-list" id="set-loc-tags"></div>
    </div>
    <div class="fg full">
      <label>Target Roles <span class="hint">(press Enter to add)</span></label>
      <input type="text" id="set-roles-input" placeholder="e.g. Enterprise Account Executive">
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
  </div>
  <div class="save-row">
    <button class="btn btn-gold" onclick="saveCriteria()">Save Settings</button>
    <span class="ok-msg" id="settings-msg" style="display:none">Saved!</span>
  </div>
</div>

</div><!-- /main-content -->
</div><!-- /app-body -->

<!-- Tailor Resume Modal -->
<div class="modal-overlay" id="tailor-modal">
  <div class="modal">
    <div class="modal-header">
      <div>
        <div style="font-size:16px;font-weight:600" id="tailor-title"></div>
        <div style="font-size:13px;color:var(--gold)" id="tailor-company"></div>
      </div>
      <button class="modal-close" onclick="closeTailorModal()">&times;</button>
    </div>
    <div id="tailor-loading" style="text-align:center;padding:32px;color:var(--muted)">Generating tailored resume &amp; cover letter with Claude...</div>
    <div id="tailor-content" style="display:none">
      <div class="modal-section">
        <h3>Tailored Resume</h3>
        <div class="modal-text" id="tailor-resume"></div>
        <button class="btn btn-ghost btn-sm copy-btn" onclick="copyText('tailor-resume')">Copy Resume</button>
      </div>
      <div class="modal-section">
        <h3>Cover Letter</h3>
        <div class="modal-text" id="tailor-cover"></div>
        <button class="btn btn-ghost btn-sm copy-btn" onclick="copyText('tailor-cover')">Copy Cover Letter</button>
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

<script>
// ── helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function lines(id) {
  return document.getElementById(id).value.split('\\n').map(function(s){return s.trim();}).filter(Boolean);
}

// ── tabs ─────────────────────────────────────────────────────────────────
var TABS = ['jobs','saved','research','companies','resume','email','runs','settings'];
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
var _currentJobsTab = 'top';
var _jobsRetries = 0;
var _repvueData = {};

function toggleRepVuePopover(jobId) {
  var pop = document.getElementById('rv-pop-' + jobId);
  if (!pop) return;
  var isShowing = pop.classList.contains('show');
  // Close all popovers first
  var allPops = document.querySelectorAll('.repvue-popover.show');
  for (var i = 0; i < allPops.length; i++) allPops[i].classList.remove('show');
  if (!isShowing) pop.classList.add('show');
}

// Close RepVue popovers when clicking outside
document.addEventListener('click', function() {
  var allPops = document.querySelectorAll('.repvue-popover.show');
  for (var i = 0; i < allPops.length; i++) allPops[i].classList.remove('show');
});

function loadRepVueData(companyName) {
  if (_repvueData[companyName] !== undefined) return;
  _repvueData[companyName] = null; // mark as loading
  fetch('/api/repvue/' + encodeURIComponent(companyName))
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d && d.data) {
        _repvueData[companyName] = d.data;
        renderJobs(); // re-render to show badge
      }
    })
    .catch(function() { /* ignore RepVue failures */ });
}

function showJobsTab(tab) {
  _currentJobsTab = tab;
  document.getElementById('jtab-top').classList.toggle('active', tab === 'top');
  document.getElementById('jtab-recent').classList.toggle('active', tab === 'recent');
  renderJobs();
}

function isNew(j) {
  if (!j.created_at) return false;
  var d = new Date(j.created_at);
  var now = new Date();
  var diff = now.getTime() - d.getTime();
  return diff < 2 * 24 * 60 * 60 * 1000; // 2 days
}

function jobAge(j) {
  if (!j.created_at) return '';
  var d = new Date(j.created_at);
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
  var rv = _repvueData[j.company];
  if (!rv) return '';
  var score = rv.repVueScore != null ? rv.repVueScore : '?';
  var pct = rv.percentHittingQuota;
  var dotClass = pct == null ? 'rv-yellow' : (pct > 50 ? 'rv-green' : (pct >= 40 ? 'rv-yellow' : 'rv-red'));
  var quotaText = rv.quotaAttainment != null ? rv.quotaAttainment + '%' : 'N/A';
  var pctText = pct != null ? pct + '%' : 'N/A';

  var popoverHtml = '<div class="repvue-popover" id="rv-pop-' + j.id + '">' +
    '<h4>RepVue: ' + esc(j.company) + '</h4>' +
    '<div class="rv-row"><span class="rv-label">Overall Score</span><span class="rv-val">' + score + '/100</span></div>' +
    '<div class="rv-row"><span class="rv-label">Quota Attainment</span><span class="rv-val">' + quotaText + '</span></div>' +
    '<div class="rv-row"><span class="rv-label">% Hitting Quota</span><span class="rv-val">' + pctText + '</span></div>' +
    (rv.baseSalaryRange ? '<div class="rv-row"><span class="rv-label">Base Salary</span><span class="rv-val">' + esc(rv.baseSalaryRange) + '</span></div>' : '') +
    (rv.oteSalaryRange ? '<div class="rv-row"><span class="rv-label">OTE</span><span class="rv-val">' + esc(rv.oteSalaryRange) + '</span></div>' : '') +
    (rv.cultureRating != null ? '<div class="rv-row"><span class="rv-label">Culture</span><span class="rv-val">' + rv.cultureRating + '/5</span></div>' : '') +
    (rv.productRating != null ? '<div class="rv-row"><span class="rv-label">Product</span><span class="rv-val">' + rv.productRating + '/5</span></div>' : '') +
    (rv.inboundLeadFlow ? '<div class="rv-row"><span class="rv-label">Inbound Lead Flow</span><span class="rv-val">' + esc(rv.inboundLeadFlow) + '</span></div>' : '');

  if (rv.reviews && rv.reviews.length) {
    popoverHtml += '<div class="rv-reviews"><strong>Recent Reviews:</strong>';
    for (var i = 0; i < rv.reviews.length; i++) {
      popoverHtml += '<div class="rv-review">' + esc(rv.reviews[i].substring(0, 200)) + '</div>';
    }
    popoverHtml += '</div>';
  }
  popoverHtml += '</div>';

  return '<span class="repvue-badge" onclick="toggleRepVuePopover(' + j.id + ');event.stopPropagation()"><span class="rv-dot ' + dotClass + '"></span>RV ' + score + popoverHtml + '</span>';
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

  return '<div class="card">' +
    '<div class="card-head">' +
      '<div class="score-row"><span>Match Score</span><span class="score-val">' + esc(j.match_score) + ' / 100</span></div>' +
      '<div class="bar-bg"><div class="bar-fg" style="width:' + esc(j.match_score) + '%;background:' + barColor + '"></div></div>' +
      '<div class="job-title">' + esc(j.title) + newBadge + '</div>' +
      '<div class="job-co">' + esc(j.company) + '</div>' +
      savedDate +
    '</div>' +
    '<div class="card-meta">' +
      '<span>\\uD83D\\uDCCD ' + esc(j.location) + '</span>' +
      salaryHtml +
      repvueBadge +
      (j.source ? '<span class="source-badge">' + esc(j.source) + '</span>' : '') +
      (jobAge(j) ? '<span class="age-badge">' + jobAge(j) + '</span>' : '') +
    '</div>' +
    (j.why_good_fit ? '<div class="card-why">' + esc(j.why_good_fit) + '</div>' : '') +
    '<div class="card-foot">' +
      '<a href="' + esc(j.apply_url) + '" target="_blank" rel="noopener" class="btn btn-gold btn-sm">View Posting \\u2192</a>' +
      '<button class="btn btn-ghost btn-sm" onclick="tailorResume(' + j.id + ')">Tailor Resume</button>' +
      '<button class="btn btn-ghost btn-sm" id="research-btn-' + j.id + '" onclick="researchCompany(' + j.id + ')">\\uD83D\\uDD0D Research Company</button>' +
      '<button class="' + saveClass + '" onclick="toggleSave(' + j.id + ')" id="save-btn-' + j.id + '">' + saveLabel + '</button>' +
    '</div>' +
  '</div>';
}

function renderJobs() {
  var grid = document.getElementById('jobs-grid');
  var cnt  = document.getElementById('jobs-count');
  var jobs;

  if (_currentJobsTab === 'top') {
    // Top matches: new matches first (sorted by score), then rest by score
    jobs = _allJobs.slice().sort(function(a, b) {
      var aNew = isNew(a) ? 1 : 0;
      var bNew = isNew(b) ? 1 : 0;
      if (bNew !== aNew) return bNew - aNew;
      return b.match_score - a.match_score;
    });
    if (!jobs.length) {
      cnt.textContent = 'No matching jobs found yet \\u2014 run the scout to find matches';
      grid.innerHTML = '';
      return;
    }
    var newTopCount = jobs.filter(isNew).length;
    cnt.textContent = jobs.length + ' top match' + (jobs.length !== 1 ? 'es' : '') + ' (score 50+)' + (newTopCount ? ' \\u2014 ' + newTopCount + ' new' : '');
    grid.innerHTML = jobs.map(function(j) { return renderJobCard(j, { showNew: true }); }).join('');
  } else {
    // Recent listings: sorted by created_at desc
    jobs = _allJobs.slice().sort(function(a, b) {
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
    if (!jobs.length) {
      cnt.textContent = 'No recent listings yet';
      grid.innerHTML = '';
      return;
    }
    var newCount = jobs.filter(isNew).length;
    cnt.textContent = jobs.length + ' listing' + (jobs.length !== 1 ? 's' : '') + (newCount ? ' (' + newCount + ' new)' : '');
    grid.innerHTML = jobs.map(function(j) { return renderJobCard(j, { showNew: true }); }).join('');
  }
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
    // Trigger RepVue data loading for unique companies
    var companies = {};
    jobs.forEach(function(j) { if (j.company && !companies[j.company]) { companies[j.company] = true; loadRepVueData(j.company); } });
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

// ── resume ────────────────────────────────────────────────────────────────
async function loadResume() {
  var res = await fetch('/api/resume');
  var data = await res.json();
  document.getElementById('resume-text').value = data.resume || '';
}
async function saveResume() {
  var text = document.getElementById('resume-text').value;
  await fetch('/api/resume', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({resume:text}) });
  var msg = document.getElementById('resume-msg');
  msg.style.display = '';
  setTimeout(function(){ msg.style.display = 'none'; }, 2500);
}
async function tailorFromDesc() {
  var resume = document.getElementById('resume-text').value.trim();
  var jobDesc = document.getElementById('job-desc-text').value.trim();
  var msg = document.getElementById('tailor-inline-msg');
  if (!resume) { msg.textContent = 'Please paste your resume first.'; msg.style.color = 'var(--red)'; return; }
  if (!jobDesc) { msg.textContent = 'Please paste a job description.'; msg.style.color = 'var(--red)'; return; }
  msg.textContent = 'Generating tailored resume with Claude...';
  msg.style.color = 'var(--gold)';
  document.getElementById('tailor-result').style.display = 'none';
  try {
    var res = await fetch('/api/tailor-freeform', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({resume:resume, jobDescription:jobDesc}) });
    var data = await res.json();
    if (data.error) { msg.textContent = 'Error: ' + data.error; msg.style.color = 'var(--red)'; return; }
    document.getElementById('tailor-result-resume').textContent = data.resume_text || '';
    document.getElementById('tailor-result-cover').textContent = data.cover_letter || '';
    document.getElementById('tailor-result').style.display = '';
    msg.textContent = '';
  } catch(e) { msg.textContent = 'Error: ' + e.message; msg.style.color = 'var(--red)'; }
}

// ── tailor resume modal ───────────────────────────────────────────────────
function closeTailorModal() {
  document.getElementById('tailor-modal').classList.remove('show');
}
function copyText(id) {
  var text = document.getElementById(id).innerText;
  navigator.clipboard.writeText(text);
}
async function tailorResume(jobId) {
  var j = _jobsById[jobId] || {};
  var title = j.title || '';
  var company = j.company || '';
  var modal = document.getElementById('tailor-modal');
  document.getElementById('tailor-title').textContent = title;
  document.getElementById('tailor-company').textContent = company;
  document.getElementById('tailor-loading').style.display = '';
  document.getElementById('tailor-content').style.display = 'none';
  modal.classList.add('show');

  try {
    var res = await fetch('/api/tailor/' + jobId, { method: 'POST' });
    var data = await res.json();
    if (data.error) {
      document.getElementById('tailor-loading').textContent = 'Error: ' + data.error;
      return;
    }
    document.getElementById('tailor-resume').textContent = data.resume_text || '';
    document.getElementById('tailor-cover').textContent = data.cover_letter || '';
    document.getElementById('tailor-loading').style.display = 'none';
    document.getElementById('tailor-content').style.display = '';
  } catch(e) {
    document.getElementById('tailor-loading').textContent = 'Error: ' + e.message;
  }
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
  if (!cos.length) { list.innerHTML = '<div class="empty">No companies added yet.</div>'; return; }
  var html = '';
  cos.forEach(function(c) {
    var detail = c.ats_slug || c.careers_url || '';
    var typeBadge = '<span class="source-badge">' + esc(c.ats_type) + '</span>';
    html +=
      '<div class="company-row">' +
        '<span class="company-name">' + esc(c.name) + '</span>' +
        typeBadge +
        '<span class="company-meta">' + esc(detail) + '</span>' +
        '<button class="btn btn-ghost btn-sm" onclick="deleteCompany(' + c.id + ')">Remove</button>' +
      '</div>';
  });
  list.innerHTML = html;
}
async function addCompany() {
  var name = document.getElementById('co-name').value.trim();
  var type = document.getElementById('co-type').value;
  var slug = document.getElementById('co-slug').value.trim();
  if (!name || !slug) { alert('Name and slug/URL are required.'); return; }
  var body = { name: name, ats_type: type };
  if (type === 'plain' || type === 'other') { body.careers_url = slug; }
  else if (type === 'workday') { body.careers_url = slug; }
  else { body.ats_slug = slug; }
  await fetch('/api/companies', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  document.getElementById('co-name').value = '';
  document.getElementById('co-slug').value = '';
  loadCompanies();
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
async function loadCriteria() {
  try {
    var res = await fetch('/api/criteria');
    if (!res.ok) throw new Error('HTTP ' + res.status);
    var c = await res.json();
    document.getElementById('set-salary').value = c.min_salary || '';
    document.getElementById('set-worktype').value = c.work_type || 'any';
    document.getElementById('set-name').value = c.your_name || '';
    document.getElementById('set-email').value = c.your_email || '';
    setTags('locations', 'set-loc-tags', c.locations);
    setTags('roles', 'set-roles-tags', c.target_roles);
    setTags('industries', 'set-ind-tags', c.industries);
    setTags('must_have', 'set-must-tags', c.must_have);
    setTags('nice_to_have', 'set-nice-tags', c.nice_to_have);
    setTags('avoid', 'set-avoid-tags', c.avoid);
    if (!_criteriaInitialized) {
      initTagInput('set-loc-input', 'set-loc-tags', 'locations');
      initTagInput('set-roles-input', 'set-roles-tags', 'roles');
      initTagInput('set-ind-input', 'set-ind-tags', 'industries');
      initTagInput('set-must-input', 'set-must-tags', 'must_have');
      initTagInput('set-nice-input', 'set-nice-tags', 'nice_to_have');
      initTagInput('set-avoid-input', 'set-avoid-tags', 'avoid');
      _criteriaInitialized = true;
    }
  } catch(e) {
    console.error('loadCriteria failed:', e);
  }
}
async function saveCriteria() {
  var body = {
    min_salary: Number(document.getElementById('set-salary').value) || null,
    work_type: document.getElementById('set-worktype').value,
    your_name: document.getElementById('set-name').value.trim(),
    your_email: document.getElementById('set-email').value.trim(),
    locations: _criteriaTagState.locations || [],
    target_roles: _criteriaTagState.roles || [],
    industries: _criteriaTagState.industries || [],
    must_have: _criteriaTagState.must_have || [],
    nice_to_have: _criteriaTagState.nice_to_have || [],
    avoid: _criteriaTagState.avoid || []
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

// ── init ──────────────────────────────────────────────────────────────────
loadJobs();
loadStats();
loadGmailStatus();
</script>
</body>
</html>`;

// suppress TS "unused" warning
void esc;
