import express, { type Request, type Response } from 'express';
import pg from 'pg';
import { scrapeGreenhouseJobs, scrapeLeverJobs, scrapeWorkdayJobs, scrapePlainWebsite } from './scraper.js';
import { scoreJobsWithClaude } from './agent.js';

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT) || 8080;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json());

// ── Database init ─────────────────────────────────────────────────────────

async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS criteria (
      id          SERIAL PRIMARY KEY,
      target_roles  TEXT[]  NOT NULL DEFAULT '{}',
      industries    TEXT[]  NOT NULL DEFAULT '{}',
      min_salary    INT,
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
      id           SERIAL PRIMARY KEY,
      status       TEXT    NOT NULL DEFAULT 'running',
      jobs_found   INT     NOT NULL DEFAULT 0,
      error        TEXT,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id           SERIAL PRIMARY KEY,
      scout_run_id INT     REFERENCES scout_runs(id),
      title        TEXT    NOT NULL,
      company      TEXT    NOT NULL,
      location     TEXT    NOT NULL DEFAULT '',
      salary       TEXT,
      apply_url    TEXT    NOT NULL,
      why_good_fit TEXT    NOT NULL DEFAULT '',
      match_score  INT     NOT NULL DEFAULT 0,
      status       TEXT    NOT NULL DEFAULT 'new',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed default criteria if none exist
  const { rows } = await pool.query('SELECT id FROM criteria LIMIT 1');
  if (rows.length === 0) {
    await pool.query(
      `INSERT INTO criteria (target_roles, industries, min_salary, locations, must_have, nice_to_have, avoid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ['Enterprise Account Executive', 'Strategic Account Executive', 'Senior Account Executive', 'Regional Sales Manager', 'Sales Director'],
        ['AI Infrastructure', 'Data Center Hardware', 'Semiconductors', 'Networking Hardware', 'Storage Hardware'],
        150000,
        ['Remote', 'New York', 'San Francisco', 'Austin', 'Boston', 'Seattle', 'Chicago'],
        ['enterprise sales', 'quota carrying', 'hardware OR infrastructure OR networking'],
        ['AI', 'data center', 'GPU', 'NVIDIA', 'hunter'],
        ['SDR', 'BDR', 'inbound only', 'SMB only', 'pure SaaS'],
      ]
    );
  }

  // Mark any stale running records as failed
  await pool.query(
    "UPDATE scout_runs SET status='failed', error='Server restarted — run was abandoned', completed_at=NOW() WHERE status='running'"
  );
}

// ── Routes ────────────────────────────────────────────────────────────────

app.get('/api/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

// Criteria
app.get('/api/criteria', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM criteria LIMIT 1');
    res.json(rows[0] ?? {});
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.put('/api/criteria', async (req: Request, res: Response) => {
  try {
    const { target_roles, industries, min_salary, locations, must_have, nice_to_have, avoid, your_name, your_email } = req.body as Record<string, unknown>;
    const { rows: existing } = await pool.query('SELECT id FROM criteria LIMIT 1');
    const params = [
      target_roles ?? [],
      industries ?? [],
      (min_salary as number | null) ?? null,
      locations ?? [],
      must_have ?? [],
      nice_to_have ?? [],
      avoid ?? [],
      (your_name as string) ?? '',
      (your_email as string) ?? '',
    ];
    if (existing.length === 0) {
      const { rows } = await pool.query(
        `INSERT INTO criteria (target_roles, industries, min_salary, locations, must_have, nice_to_have, avoid, your_name, your_email)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        params
      );
      res.json(rows[0]);
    } else {
      const { rows } = await pool.query(
        `UPDATE criteria SET target_roles=$1, industries=$2, min_salary=$3, locations=$4,
         must_have=$5, nice_to_have=$6, avoid=$7, your_name=$8, your_email=$9
         WHERE id=$10 RETURNING *`,
        [...params, existing[0].id as number]
      );
      res.json(rows[0]);
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Companies
app.get('/api/companies', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM companies ORDER BY name');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/companies', async (req: Request, res: Response) => {
  try {
    const { name, ats_type, ats_slug, careers_url } = req.body as Record<string, string>;
    const { rows } = await pool.query(
      `INSERT INTO companies (name, ats_type, ats_slug, careers_url) VALUES ($1,$2,$3,$4) RETURNING *`,
      [name, ats_type ?? 'greenhouse', ats_slug ?? null, careers_url ?? null]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.delete('/api/companies/:id', async (req: Request, res: Response) => {
  try {
    await pool.query('DELETE FROM companies WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Jobs
app.get('/api/jobs', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM jobs ORDER BY match_score DESC, created_at DESC LIMIT 100');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Scout
app.get('/api/scout/status', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM scout_runs ORDER BY started_at DESC LIMIT 20');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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
    const run = rows[0] as { id: number };
    res.json({ runId: run.id, message: 'Scout run started' });
    scoutRunning = true;
    runScoutInBackground(run.id).catch(console.error).finally(() => { scoutRunning = false; });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ── Scout background worker ───────────────────────────────────────────────

const HARDCODED_WORKDAY = [
  { slug: 'cisco',   domain: 'cisco.wd5.myworkdayjobs.com',  name: 'Cisco' },
  { slug: 'nvidia',  domain: 'nvidia.wd5.myworkdayjobs.com', name: 'NVIDIA',             careerSite: 'NVIDIAExternalCareerSite' },
  { slug: 'dell',    domain: 'dell.wd1.myworkdayjobs.com',   name: 'Dell Technologies',  careerSite: 'ExternalNonPublic' },
];

const SALES_INCLUDE = /\b(account\s+executive|sales\s+director|director\s+of\s+sales|vp\s+of?\s+sales|regional\s+sales|territory\s+sales|named\s+account|major\s+account|strategic\s+account|enterprise\s+account)\b/i;
const SALES_EXCLUDE = /\b(engineer|developer|software|scientist|analyst|marketing|designer|recruiter|\bhr\b|finance|accounting|legal|product\s+manager|program\s+manager|project\s+manager|intern|coordinator|specialist|support|customer\s+success|operations|architect|data\b|cloud\s+sales\s+engineer)\b/i;

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

    type Job = Awaited<ReturnType<typeof scrapeGreenhouseJobs>>[number];
    const allJobs: Job[] = [];

    for (const c of companies) {
      const co = c as { name: string; ats_type: string; ats_slug: string | null; careers_url: string | null };
      if (co.ats_type === 'greenhouse' && co.ats_slug) {
        allJobs.push(...await scrapeGreenhouseJobs(co.ats_slug, co.name));
      } else if (co.ats_type === 'lever' && co.ats_slug) {
        allJobs.push(...await scrapeLeverJobs(co.ats_slug, co.name));
      } else if (co.careers_url) {
        allJobs.push(...await scrapePlainWebsite(co.careers_url, co.name));
      }
    }

    for (const co of HARDCODED_WORKDAY) {
      allJobs.push(...await scrapeWorkdayJobs(co.slug, co.domain, co.name, co.careerSite));
    }

    console.log(`\nTotal scraped: ${allJobs.length} listings`);

    const filtered = allJobs.filter((j) => SALES_INCLUDE.test(j.title) && !SALES_EXCLUDE.test(j.title));
    const toScore = filtered.slice(0, 80);
    console.log(`Pre-filter: ${filtered.length} matched; sending ${toScore.length} to Claude`);

    if (toScore.length === 0) {
      await pool.query("UPDATE scout_runs SET status='completed', jobs_found=0, completed_at=NOW() WHERE id=$1", [runId]);
      return;
    }

    const matches = await scoreJobsWithClaude(toScore, {
      targetRoles: criteria.target_roles,
      industries: criteria.industries,
      minSalary: criteria.min_salary,
      locations: criteria.locations,
      mustHave: criteria.must_have,
      niceToHave: criteria.nice_to_have,
      avoid: criteria.avoid,
    });

    for (const m of matches) {
      await pool.query(
        `INSERT INTO jobs (scout_run_id, title, company, location, salary, apply_url, why_good_fit, match_score)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [runId, m.title, m.company, m.location, m.salary ?? null, m.applyUrl, m.whyGoodFit, m.matchScore]
      );
    }

    await pool.query(
      "UPDATE scout_runs SET status='completed', jobs_found=$1, completed_at=NOW() WHERE id=$2",
      [matches.length, runId]
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await pool.query(
      "UPDATE scout_runs SET status='failed', error=$1, completed_at=NOW() WHERE id=$2",
      [msg, runId]
    );
  }
}

// ── HTML dashboard ────────────────────────────────────────────────────────

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function serveHTML(_req: Request, res: Response): void {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(HTML);
}

app.get('/', serveHTML);
app.get('/index.html', serveHTML);

// ── Start server ──────────────────────────────────────────────────────────

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Job Scout Agent listening on port ${PORT}`);
    });
  })
  .catch((err: unknown) => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });

// ── HTML constant ─────────────────────────────────────────────────────────
// Note: kept at bottom so the server starts without waiting for this string to parse.
// All JavaScript inside uses string concatenation (not template literals) to avoid
// escaping conflicts with the TypeScript template literal.

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Job Scout Agent</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0f0f0f;--surface:#161616;--border:#252525;--text:#e8e6e0;--muted:#666;--gold:#c8a96e;--green:#4caf88;--red:#cf6679;--r:10px}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;min-height:100vh}

/* header */
header{border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;gap:10px}
.logo{font-size:15px;font-weight:600;color:var(--gold);letter-spacing:-0.01em}
.hdr-status{font-size:12px;color:var(--muted);margin-left:auto}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0}
.dot.running{background:var(--gold);animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}

/* run bar */
.run-bar{padding:14px 24px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:7px;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:opacity .15s;text-decoration:none}
.btn:hover:not(:disabled){opacity:.8}
.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-gold{background:var(--gold);color:#0f0f0f}
.btn-ghost{background:var(--surface);color:var(--text);border:1px solid var(--border)}
.run-msg{font-size:12px;color:var(--muted)}

/* tabs */
.tabs{display:flex;gap:0;padding:0 24px;border-bottom:1px solid var(--border)}
.tab{padding:10px 14px;font-size:13px;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none}
.tab.active{color:var(--text);border-color:var(--gold)}
.panel{display:none;padding:24px}
.panel.active{display:block}

/* jobs */
.jobs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px;margin-top:16px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden}
.card-head{padding:16px 18px 12px;border-bottom:1px solid #1e1e1e}
.score-row{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:6px}
.score-val{color:var(--gold);font-size:13px;font-weight:600}
.bar-bg{height:3px;background:#222;border-radius:2px}
.bar-fg{height:3px;background:var(--gold);border-radius:2px}
.job-title{font-size:15px;font-weight:600;margin:10px 0 3px}
.job-co{font-size:13px;color:var(--gold)}
.card-meta{padding:9px 18px;border-bottom:1px solid #1e1e1e;font-size:12px;color:var(--muted)}
.card-why{padding:12px 18px;border-bottom:1px solid #1e1e1e;font-size:12px;color:#999;line-height:1.6}
.card-foot{padding:12px 18px}

/* table */
.tbl{width:100%;border-collapse:collapse}
.tbl th{text-align:left;padding:8px 12px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border)}
.tbl td{padding:10px 12px;font-size:13px;border-bottom:1px solid #1a1a1a;vertical-align:top}
.badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600;text-transform:uppercase}
.b-running{background:#2a2010;color:var(--gold)}
.b-completed{background:#0d2318;color:var(--green)}
.b-failed{background:#2a1018;color:var(--red)}

/* criteria form */
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:820px}
@media(max-width:600px){.form-grid{grid-template-columns:1fr}}
.fg{display:flex;flex-direction:column;gap:6px}
.fg.full{grid-column:1/-1}
label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
textarea,input{background:var(--surface);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 12px;font-size:13px;font-family:inherit;resize:vertical;outline:none;width:100%}
textarea:focus,input:focus{border-color:var(--gold)}
.hint{font-size:11px;color:var(--muted);margin-top:2px}
.save-row{margin-top:20px;display:flex;align-items:center;gap:12px}
.ok-msg{font-size:12px;color:var(--green)}

/* companies */
.company-list{max-width:640px;margin-bottom:20px}
.company-row{display:flex;align-items:center;gap:10px;padding:10px 14px;background:var(--surface);border:1px solid var(--border);border-radius:7px;margin-bottom:8px}
.company-name{font-weight:600;flex:1}
.company-meta{font-size:12px;color:var(--muted)}
.add-form{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;max-width:640px;margin-top:16px}
@media(max-width:600px){.add-form{grid-template-columns:1fr}}

.empty{padding:48px;text-align:center;color:var(--muted);font-size:13px}
.sec-title{font-size:12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
</style>
</head>
<body>

<header>
  <span class="logo">&#x2B21; Job Scout Agent</span>
  <span class="hdr-status" id="hdr-status"></span>
  <span class="dot" id="dot"></span>
</header>

<div class="run-bar">
  <button class="btn btn-gold" id="run-btn" onclick="runScout()">&#9654; Run Scout Now</button>
  <span class="run-msg" id="run-msg"></span>
</div>

<div class="tabs">
  <div class="tab active" id="tab-jobs"     onclick="showTab('jobs')">Jobs</div>
  <div class="tab"        id="tab-runs"     onclick="showTab('runs')">Run History</div>
  <div class="tab"        id="tab-criteria" onclick="showTab('criteria')">Criteria</div>
  <div class="tab"        id="tab-companies" onclick="showTab('companies')">Companies</div>
</div>

<div class="panel active" id="panel-jobs">
  <div class="sec-title" id="jobs-count">Loading jobs&hellip;</div>
  <div class="jobs-grid" id="jobs-grid"></div>
</div>

<div class="panel" id="panel-runs">
  <table class="tbl">
    <thead><tr>
      <th>#</th><th>Status</th><th>Jobs Found</th><th>Started</th><th>Completed</th><th>Error</th>
    </tr></thead>
    <tbody id="runs-body"></tbody>
  </table>
  <div class="empty" id="runs-empty" style="display:none">No scout runs yet.</div>
</div>

<div class="panel" id="panel-criteria">
  <form onsubmit="saveCriteria(event)">
    <div class="form-grid">
      <div class="fg"><label>Your Name</label><input type="text" id="c-name" placeholder="Jane Smith"></div>
      <div class="fg"><label>Your Email</label><input type="email" id="c-email" placeholder="jane@example.com"></div>
      <div class="fg"><label>Min Salary</label><input type="number" id="c-salary" placeholder="150000"></div>
      <div class="fg"></div>
      <div class="fg"><label>Target Roles</label><textarea id="c-roles" rows="5" placeholder="One per line"></textarea><span class="hint">One role per line</span></div>
      <div class="fg"><label>Industries</label><textarea id="c-industries" rows="5" placeholder="One per line"></textarea></div>
      <div class="fg"><label>Locations</label><textarea id="c-locations" rows="4" placeholder="One per line"></textarea></div>
      <div class="fg"><label>Must Have</label><textarea id="c-musthave" rows="4" placeholder="One per line"></textarea></div>
      <div class="fg"><label>Nice To Have</label><textarea id="c-nicetohave" rows="4" placeholder="One per line"></textarea></div>
      <div class="fg"><label>Avoid</label><textarea id="c-avoid" rows="4" placeholder="One per line"></textarea></div>
    </div>
    <div class="save-row">
      <button type="submit" class="btn btn-gold">Save Criteria</button>
      <span class="ok-msg" id="save-msg" style="display:none">Saved!</span>
    </div>
  </form>
</div>

<div class="panel" id="panel-companies">
  <div class="company-list" id="company-list"></div>
  <div class="sec-title" style="margin-bottom:12px">Add Company</div>
  <div class="add-form">
    <div class="fg"><label>Company Name</label><input type="text" id="co-name" placeholder="Acme Corp"></div>
    <div class="fg">
      <label>ATS Type</label>
      <select id="co-type" style="background:var(--surface);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 12px;font-size:13px;width:100%;outline:none">
        <option value="greenhouse">Greenhouse</option>
        <option value="lever">Lever</option>
        <option value="other">Plain URL</option>
      </select>
    </div>
    <div class="fg"><label>ATS Slug or URL</label><input type="text" id="co-slug" placeholder="companyname or https://..."></div>
  </div>
  <div style="margin-top:12px">
    <button class="btn btn-gold" onclick="addCompany()">Add Company</button>
  </div>
</div>

<script>
// ── helpers ──────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function lines(id) {
  return document.getElementById(id).value.split('\\n').map(function(s){return s.trim();}).filter(Boolean);
}

// ── tabs ─────────────────────────────────────────────────────────────────
var TABS = ['jobs','runs','criteria','companies'];
function showTab(name) {
  TABS.forEach(function(t) {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('panel-' + t).classList.toggle('active', t === name);
  });
  if (name === 'runs')      loadRuns();
  if (name === 'criteria')  loadCriteria();
  if (name === 'companies') loadCompanies();
}

// ── jobs ─────────────────────────────────────────────────────────────────
async function loadJobs() {
  var res = await fetch('/api/jobs');
  var jobs = await res.json();
  var grid = document.getElementById('jobs-grid');
  var cnt  = document.getElementById('jobs-count');
  if (!jobs.length) {
    cnt.textContent = 'No jobs found yet \u2014 run the scout to find matches';
    grid.innerHTML = '';
    return;
  }
  cnt.textContent = jobs.length + ' job' + (jobs.length !== 1 ? 's' : '') + ' found';
  var html = '';
  jobs.forEach(function(j) {
    html +=
      '<div class="card">' +
        '<div class="card-head">' +
          '<div class="score-row"><span>Match Score</span><span class="score-val">' + esc(j.match_score) + ' / 100</span></div>' +
          '<div class="bar-bg"><div class="bar-fg" style="width:' + esc(j.match_score) + '%"></div></div>' +
          '<div class="job-title">' + esc(j.title) + '</div>' +
          '<div class="job-co">'   + esc(j.company) + '</div>' +
        '</div>' +
        '<div class="card-meta">\uD83D\uDCCD ' + esc(j.location) + (j.salary ? '&nbsp;&nbsp;\uD83D\uDCB0 ' + esc(j.salary) : '') + '</div>' +
        (j.why_good_fit ? '<div class="card-why">' + esc(j.why_good_fit) + '</div>' : '') +
        '<div class="card-foot"><a href="' + esc(j.apply_url) + '" target="_blank" rel="noopener" class="btn btn-gold" style="font-size:12px">Apply \u2192</a></div>' +
      '</div>';
  });
  grid.innerHTML = html;
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
        '<td>' + esc(r.jobs_found) + '</td>' +
        '<td>' + (r.started_at   ? new Date(r.started_at).toLocaleString()   : '\u2014') + '</td>' +
        '<td>' + (r.completed_at ? new Date(r.completed_at).toLocaleString() : '\u2014') + '</td>' +
        '<td style="color:var(--red);font-size:12px">' + esc(r.error || '') + '</td>' +
      '</tr>';
  });
  tbody.innerHTML = html;
  var latest = runs[0];
  if (latest) {
    document.getElementById('dot').className = 'dot' + (latest.status === 'running' ? ' running' : '');
    document.getElementById('hdr-status').textContent = 'Last run: ' + new Date(latest.started_at).toLocaleString();
  }
}

// ── criteria ──────────────────────────────────────────────────────────────
async function loadCriteria() {
  var res = await fetch('/api/criteria');
  var c   = await res.json();
  document.getElementById('c-name').value      = c.your_name   || '';
  document.getElementById('c-email').value     = c.your_email  || '';
  document.getElementById('c-salary').value    = c.min_salary  || '';
  document.getElementById('c-roles').value     = (c.target_roles  || []).join('\\n');
  document.getElementById('c-industries').value= (c.industries    || []).join('\\n');
  document.getElementById('c-locations').value = (c.locations     || []).join('\\n');
  document.getElementById('c-musthave').value  = (c.must_have     || []).join('\\n');
  document.getElementById('c-nicetohave').value= (c.nice_to_have  || []).join('\\n');
  document.getElementById('c-avoid').value     = (c.avoid         || []).join('\\n');
}
async function saveCriteria(e) {
  e.preventDefault();
  var body = {
    your_name:    document.getElementById('c-name').value.trim(),
    your_email:   document.getElementById('c-email').value.trim(),
    min_salary:   parseInt(document.getElementById('c-salary').value) || null,
    target_roles: lines('c-roles'),
    industries:   lines('c-industries'),
    locations:    lines('c-locations'),
    must_have:    lines('c-musthave'),
    nice_to_have: lines('c-nicetohave'),
    avoid:        lines('c-avoid'),
  };
  await fetch('/api/criteria', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
  var msg = document.getElementById('save-msg');
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
    var slug = c.ats_slug || c.careers_url || '';
    html +=
      '<div class="company-row">' +
        '<span class="company-name">' + esc(c.name) + '</span>' +
        '<span class="company-meta">' + esc(c.ats_type) + (slug ? ': ' + esc(slug) : '') + '</span>' +
        '<button class="btn btn-ghost" style="padding:5px 12px;font-size:12px" onclick="deleteCompany(' + esc(c.id) + ')">Remove</button>' +
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
  if (type === 'other') { body.careers_url = slug; } else { body.ats_slug = slug; }
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
  msg.textContent = 'Starting\u2026';
  var res = await fetch('/api/scout/run', { method:'POST' });
  if (!res.ok) {
    var d = await res.json();
    msg.textContent = d.error || 'Error starting run';
    btn.disabled = false;
    return;
  }
  document.getElementById('dot').className = 'dot running';
  msg.textContent = 'Scraping job boards and scoring with Claude\u2026';
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async function() {
    var r = await fetch('/api/scout/status');
    var runs = await r.json();
    var latest = runs[0];
    if (!latest) return;
    if (latest.status !== 'running') {
      clearInterval(pollTimer); pollTimer = null;
      btn.disabled = false;
      document.getElementById('dot').className = 'dot';
      document.getElementById('hdr-status').textContent = 'Last run: ' + new Date(latest.started_at).toLocaleString();
      if (latest.status === 'completed') {
        msg.textContent = 'Done! Found ' + latest.jobs_found + ' match' + (latest.jobs_found !== 1 ? 'es' : '');
        loadJobs();
      } else {
        msg.textContent = 'Run failed: ' + (latest.error || 'unknown error');
      }
    }
  }, 2000);
}

// ── init ──────────────────────────────────────────────────────────────────
loadJobs();
loadRuns();
</script>
</body>
</html>`;

// suppress TS "unused" warning — esc is used in serveHTML
void esc;
