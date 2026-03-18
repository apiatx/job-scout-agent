import express, { type Request, type Response } from 'express';
import pg from 'pg';
import { scrapeGreenhouseJobs, scrapeWorkdayJobs, scrapePlainWebsite } from './scraper.js';
import { scoreJobsWithClaude, tailorResumeWithClaude } from './agent.js';

const { Pool } = pg;
const app = express();
const PORT = Number(process.env.PORT) || 8080;

// ── HEALTH CHECK — must be first route, no DB dependency ──────────────────
app.get('/health', (_req, res) => { res.sendStatus(200); });
app.get('/api/healthz', (_req, res) => { res.json({ status: 'ok' }); });

app.use(express.json());

// ── DB setup ──────────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// ── Gmail OAuth helpers ────────────────────────────────────────────────────
const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/userinfo.email';

function getGmailAuthUrl(): string {
  const params = new URLSearchParams({
    client_id: process.env.GMAIL_CLIENT_ID ?? '',
    redirect_uri: process.env.GMAIL_REDIRECT_URI ?? '',
    response_type: 'code',
    scope: GMAIL_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeGmailCode(code: string): Promise<{ access_token: string; refresh_token?: string; expires_in: number; token_type: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID ?? '',
      client_secret: process.env.GMAIL_CLIENT_SECRET ?? '',
      redirect_uri: process.env.GMAIL_REDIRECT_URI ?? '',
      code,
      grant_type: 'authorization_code',
    }),
  });
  return res.json() as Promise<{ access_token: string; refresh_token?: string; expires_in: number; token_type: string }>;
}

async function refreshGmailAccessToken(refreshToken: string): Promise<{ access_token: string; expires_in: number }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID ?? '',
      client_secret: process.env.GMAIL_CLIENT_SECRET ?? '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  return res.json() as Promise<{ access_token: string; expires_in: number }>;
}

async function getValidGmailToken(): Promise<{ accessToken: string; email: string } | null> {
  const { rows } = await pool.query('SELECT * FROM gmail_tokens ORDER BY id DESC LIMIT 1');
  if (rows.length === 0) return null;
  const token = rows[0] as { id: number; email: string; access_token: string; refresh_token: string | null; expiry_date: Date | null };
  const isExpired = token.expiry_date && new Date(token.expiry_date) < new Date(Date.now() + 60000);
  if (isExpired && token.refresh_token) {
    const refreshed = await refreshGmailAccessToken(token.refresh_token);
    const newExpiry = new Date(Date.now() + refreshed.expires_in * 1000);
    await pool.query('UPDATE gmail_tokens SET access_token=$1, expiry_date=$2 WHERE id=$3', [refreshed.access_token, newExpiry, token.id]);
    return { accessToken: refreshed.access_token, email: token.email };
  }
  return { accessToken: token.access_token, email: token.email };
}

async function getGmailUserEmail(accessToken: string): Promise<string> {
  const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const data = await res.json() as { email?: string };
  return data.email ?? 'unknown@gmail.com';
}

async function sendGmailMessage(accessToken: string, to: string, subject: string, htmlBody: string): Promise<void> {
  const raw = [
    `To: ${to}`,
    'Content-Type: text/html; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    htmlBody,
  ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gmail send failed: ${err}`);
  }
}

// ── DB init ───────────────────────────────────────────────────────────────
async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS criteria (
      id            SERIAL PRIMARY KEY,
      target_roles  TEXT[]  NOT NULL DEFAULT '{}',
      industries    TEXT[]  NOT NULL DEFAULT '{}',
      min_salary    INT,
      locations     TEXT[]  NOT NULL DEFAULT '{}',
      must_have     TEXT[]  NOT NULL DEFAULT '{}',
      nice_to_have  TEXT[]  NOT NULL DEFAULT '{}',
      avoid         TEXT[]  NOT NULL DEFAULT '{}',
      your_name     TEXT    NOT NULL DEFAULT '',
      your_email    TEXT    NOT NULL DEFAULT '',
      schedule_time TEXT
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
      email_sent   BOOLEAN NOT NULL DEFAULT false,
      error        TEXT,
      started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id               SERIAL PRIMARY KEY,
      scout_run_id     INT     REFERENCES scout_runs(id),
      title            TEXT    NOT NULL,
      company          TEXT    NOT NULL,
      location         TEXT    NOT NULL DEFAULT '',
      salary           TEXT,
      apply_url        TEXT    NOT NULL,
      why_good_fit     TEXT    NOT NULL DEFAULT '',
      match_score      INT     NOT NULL DEFAULT 0,
      source           TEXT    NOT NULL DEFAULT '',
      status           TEXT    NOT NULL DEFAULT 'new',
      tailored_resume  TEXT,
      cover_letter     TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS resume_content (
      id         SERIAL PRIMARY KEY,
      content    TEXT    NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS gmail_tokens (
      id            SERIAL PRIMARY KEY,
      email         TEXT    NOT NULL,
      access_token  TEXT    NOT NULL,
      refresh_token TEXT,
      token_type    TEXT    NOT NULL DEFAULT 'Bearer',
      expiry_date   TIMESTAMPTZ,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Add columns to existing tables if upgrading
  await pool.query(`
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT '';
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS tailored_resume TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cover_letter TEXT;
    ALTER TABLE scout_runs ADD COLUMN IF NOT EXISTS email_sent BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE criteria ADD COLUMN IF NOT EXISTS schedule_time TEXT;
  `);

  // Seed default criteria if none exist
  const { rows: critRows } = await pool.query('SELECT id FROM criteria LIMIT 1');
  if (critRows.length === 0) {
    await pool.query(
      `INSERT INTO criteria (target_roles, industries, min_salary, locations, must_have, nice_to_have, avoid)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        ['Enterprise Account Executive', 'Strategic Account Executive', 'Senior Account Executive', 'Regional Sales Manager', 'Sales Director', 'Major Account Executive'],
        ['AI Infrastructure', 'Data Center Hardware', 'Semiconductors', 'Networking Hardware', 'Storage', 'Optical Networking', 'Edge Computing', 'Server Hardware'],
        150000,
        ['Remote', 'New York', 'San Francisco', 'Austin', 'Boston', 'Seattle'],
        ['enterprise sales', 'quota carrying'],
        ['AI', 'data center', 'GPU', 'cloud infrastructure', 'hunter'],
        ['SDR', 'BDR', 'inbound only', 'SMB only', 'marketing', 'recruiting', 'engineering'],
      ]
    );
  }

  // Seed companies — always replace Greenhouse companies with the canonical list
  await pool.query("DELETE FROM companies WHERE ats_type = 'greenhouse'");
  const greenhouseSlugs: Array<{ slug: string; name: string }> = [
    { slug: 'purestorage',       name: 'Pure Storage' },
    { slug: 'coreweave',         name: 'CoreWeave' },
    { slug: 'zscaler',           name: 'Zscaler' },
    { slug: 'rubrik',            name: 'Rubrik' },
    { slug: 'samsara',           name: 'Samsara' },
    { slug: 'datadog',           name: 'Datadog' },
    { slug: 'databricks',        name: 'Databricks' },
    { slug: 'snowflake-computing', name: 'Snowflake' },
    { slug: 'nutanix',           name: 'Nutanix' },
    { slug: 'paloaltonetworks',  name: 'Palo Alto Networks' },
    { slug: 'aristanw',          name: 'Arista Networks' },
    { slug: 'lumentum',          name: 'Lumentum' },
    { slug: 'coherent',          name: 'Coherent Corp' },
    { slug: 'marvell',           name: 'Marvell Technology' },
    { slug: 'nvidia',            name: 'NVIDIA' },
    { slug: 'broadcom',          name: 'Broadcom' },
  ];
  for (const c of greenhouseSlugs) {
    await pool.query(
      `INSERT INTO companies (name, ats_type, ats_slug) VALUES ($1, 'greenhouse', $2)`,
      [c.name, c.slug]
    );
  }

  // Seed plain-website companies if not already present
  const plainCompanies: Array<{ name: string; url: string }> = [
    { name: 'Juniper Networks', url: 'https://jobs.juniper.net' },
    { name: 'Eaton',            url: 'https://jobs.eaton.com' },
    { name: 'Keysight',         url: 'https://careers.keysight.com' },
  ];
  for (const c of plainCompanies) {
    const { rows } = await pool.query("SELECT id FROM companies WHERE careers_url=$1", [c.url]);
    if (rows.length === 0) {
      await pool.query(
        `INSERT INTO companies (name, ats_type, careers_url) VALUES ($1, 'other', $2)`,
        [c.name, c.url]
      );
    }
  }

  // Seed empty resume record if none exists
  const { rows: resRows } = await pool.query('SELECT id FROM resume_content LIMIT 1');
  if (resRows.length === 0) {
    await pool.query("INSERT INTO resume_content (content) VALUES ('')");
  }

  // Mark stale running scout runs as failed
  await pool.query(
    "UPDATE scout_runs SET status='failed', error='Server restarted — run was abandoned', completed_at=NOW() WHERE status='running'"
  );
}

// ── Routes ─────────────────────────────────────────────────────────────────

// Stats
app.get('/api/stats', async (_req, res: Response) => {
  try {
    const [totalRes, todayRes, topRes, runRes, critRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int AS count FROM jobs'),
      pool.query("SELECT COUNT(*)::int AS count FROM jobs WHERE created_at >= CURRENT_DATE"),
      pool.query("SELECT MAX(match_score)::int AS top FROM jobs WHERE created_at >= CURRENT_DATE"),
      pool.query("SELECT started_at, status FROM scout_runs ORDER BY started_at DESC LIMIT 1"),
      pool.query("SELECT schedule_time FROM criteria LIMIT 1"),
    ]);
    res.json({
      total_jobs: totalRes.rows[0]?.count ?? 0,
      matches_today: todayRes.rows[0]?.count ?? 0,
      top_score_today: topRes.rows[0]?.top ?? null,
      last_run: runRes.rows[0]?.started_at ?? null,
      last_run_status: runRes.rows[0]?.status ?? null,
      schedule_time: critRes.rows[0]?.schedule_time ?? null,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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
    const { target_roles, industries, min_salary, locations, must_have, nice_to_have, avoid, your_name, your_email, schedule_time } = req.body as Record<string, unknown>;
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
      (schedule_time as string | null) ?? null,
    ];
    if (existing.length === 0) {
      const { rows } = await pool.query(
        `INSERT INTO criteria (target_roles, industries, min_salary, locations, must_have, nice_to_have, avoid, your_name, your_email, schedule_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        params
      );
      res.json(rows[0]);
    } else {
      const { rows } = await pool.query(
        `UPDATE criteria SET target_roles=$1, industries=$2, min_salary=$3, locations=$4,
         must_have=$5, nice_to_have=$6, avoid=$7, your_name=$8, your_email=$9, schedule_time=$10
         WHERE id=$11 RETURNING *`,
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
    const { rows } = await pool.query('SELECT * FROM jobs ORDER BY match_score DESC, created_at DESC LIMIT 200');
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/jobs/:id', async (req: Request, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [req.params.id]);
    if (rows.length === 0) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Resume tailor
app.post('/api/jobs/:id/tailor', async (req: Request, res: Response) => {
  try {
    const { rows: jobRows } = await pool.query('SELECT * FROM jobs WHERE id=$1', [req.params.id]);
    if (jobRows.length === 0) { res.status(404).json({ error: 'Job not found' }); return; }
    const job = jobRows[0] as { id: number; title: string; company: string; why_good_fit: string; tailored_resume: string | null; cover_letter: string | null };

    // Return cached result if already tailored
    if (job.tailored_resume && job.cover_letter) {
      res.json({ tailoredResume: job.tailored_resume, coverLetter: job.cover_letter });
      return;
    }

    const { rows: resumeRows } = await pool.query('SELECT content FROM resume_content LIMIT 1');
    const baseResume = (resumeRows[0]?.content as string) ?? '';
    if (!baseResume.trim()) {
      res.status(400).json({ error: 'No base resume found. Please add your resume in Settings first.' });
      return;
    }

    const result = await tailorResumeWithClaude(job.title, job.company, job.why_good_fit, baseResume);
    await pool.query(
      'UPDATE jobs SET tailored_resume=$1, cover_letter=$2 WHERE id=$3',
      [result.tailoredResume, result.coverLetter, job.id]
    );
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Resume
app.get('/api/resume', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT * FROM resume_content LIMIT 1');
    res.json({ content: rows[0]?.content ?? '', updated_at: rows[0]?.updated_at ?? null });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.put('/api/resume', async (req: Request, res: Response) => {
  try {
    const { content } = req.body as { content: string };
    const { rows: existing } = await pool.query('SELECT id FROM resume_content LIMIT 1');
    if (existing.length === 0) {
      await pool.query('INSERT INTO resume_content (content) VALUES ($1)', [content ?? '']);
    } else {
      await pool.query('UPDATE resume_content SET content=$1, updated_at=NOW() WHERE id=$2', [content ?? '', existing[0].id]);
    }
    res.json({ ok: true });
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

// Gmail
app.get('/api/gmail/status', async (_req, res: Response) => {
  try {
    const { rows } = await pool.query('SELECT email, expiry_date FROM gmail_tokens ORDER BY id DESC LIMIT 1');
    if (rows.length === 0) {
      res.json({ connected: false, email: null });
    } else {
      const t = rows[0] as { email: string; expiry_date: Date | null };
      res.json({ connected: true, email: t.email });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get('/api/gmail/setup-url', (_req, res: Response) => {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_CLIENT_SECRET) {
    res.status(400).json({ error: 'GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables are not set.' });
    return;
  }
  res.json({ url: getGmailAuthUrl() });
});

app.get('/api/gmail/callback', async (req: Request, res: Response) => {
  const { code } = req.query as { code?: string };
  if (!code) {
    res.status(400).send('Missing authorization code');
    return;
  }
  try {
    const tokens = await exchangeGmailCode(code);
    const email = await getGmailUserEmail(tokens.access_token);
    const expiry = new Date(Date.now() + tokens.expires_in * 1000);
    await pool.query('DELETE FROM gmail_tokens');
    await pool.query(
      `INSERT INTO gmail_tokens (email, access_token, refresh_token, token_type, expiry_date)
       VALUES ($1, $2, $3, $4, $5)`,
      [email, tokens.access_token, tokens.refresh_token ?? null, tokens.token_type ?? 'Bearer', expiry]
    );
    res.redirect('/?gmail=connected');
  } catch (e) {
    res.status(500).send(`Gmail OAuth error: ${String(e)}`);
  }
});

app.post('/api/gmail/disconnect', async (_req, res: Response) => {
  try {
    await pool.query('DELETE FROM gmail_tokens');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post('/api/gmail/send-digest', async (_req, res: Response) => {
  try {
    const tokenInfo = await getValidGmailToken();
    if (!tokenInfo) {
      res.status(400).json({ error: 'Gmail not connected. Please connect Gmail in Settings.' });
      return;
    }
    const { rows: jobs } = await pool.query(
      "SELECT * FROM jobs WHERE created_at >= CURRENT_DATE ORDER BY match_score DESC LIMIT 50"
    );
    if (jobs.length === 0) {
      res.status(400).json({ error: 'No jobs found today. Run the scout first.' });
      return;
    }
    const jobRows = jobs as Array<{ title: string; company: string; location: string; salary: string | null; match_score: number; why_good_fit: string; apply_url: string; source: string }>;
    const htmlBody = buildDigestEmail(jobRows);
    const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    await sendGmailMessage(
      tokenInfo.accessToken,
      tokenInfo.email,
      `Job Scout — ${jobRows.length} matches for ${today}`,
      htmlBody
    );
    res.json({ ok: true, sent: jobRows.length, to: tokenInfo.email });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

function buildDigestEmail(jobs: Array<{ title: string; company: string; location: string; salary: string | null; match_score: number; why_good_fit: string; apply_url: string; source: string }>): string {
  const rows = jobs.map((j) => `
    <tr>
      <td style="padding:16px;border-bottom:1px solid #2a2a2a;vertical-align:top">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">
          <div>
            <div style="font-size:16px;font-weight:700;color:#e8e6e0;margin-bottom:2px">${j.title}</div>
            <div style="font-size:14px;color:#c8a96e;font-weight:600">${j.company}</div>
          </div>
          <div style="background:#1a1a1a;border:1px solid #c8a96e;border-radius:6px;padding:6px 12px;text-align:center;white-space:nowrap">
            <div style="font-size:18px;font-weight:800;color:#c8a96e">${j.match_score}</div>
            <div style="font-size:10px;color:#888;text-transform:uppercase;letter-spacing:0.05em">/ 100</div>
          </div>
        </div>
        <div style="font-size:12px;color:#888;margin-bottom:10px">
          📍 ${j.location}${j.salary ? `&nbsp;&nbsp;💰 ${j.salary}` : ''}&nbsp;&nbsp;<span style="background:#1a2a1a;color:#4caf88;padding:2px 6px;border-radius:4px;font-size:11px">${j.source}</span>
        </div>
        <div style="font-size:13px;color:#aaa;line-height:1.6;margin-bottom:12px">${j.why_good_fit}</div>
        <a href="${j.apply_url}" style="display:inline-block;background:#c8a96e;color:#0f0f0f;text-decoration:none;padding:8px 18px;border-radius:6px;font-size:13px;font-weight:700">Apply Now →</a>
      </td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#0f0f0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f0f0f">
    <tr><td align="center" style="padding:32px 16px">
      <table width="640" cellpadding="0" cellspacing="0" style="max-width:640px;width:100%">
        <tr>
          <td style="background:#111114;border:1px solid #1e1e26;border-radius:12px;overflow:hidden">
            <div style="background:linear-gradient(135deg,#161616,#111114);padding:28px 32px;border-bottom:1px solid #1e1e26">
              <div style="font-size:22px;font-weight:800;color:#c8a96e;letter-spacing:-0.02em">⬡ Job Scout Agent</div>
              <div style="font-size:14px;color:#666;margin-top:4px">${jobs.length} matches found today — ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</div>
            </div>
            <table width="100%" cellpadding="0" cellspacing="0">
              ${rows}
            </table>
            <div style="padding:20px 32px;border-top:1px solid #1e1e26;text-align:center">
              <div style="font-size:11px;color:#444">Sent by Job Scout Agent · <a href="#" style="color:#666">Manage settings</a></div>
            </div>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// ── Scout background worker ───────────────────────────────────────────────

const HARDCODED_WORKDAY = [
  { slug: 'cisco',           domain: 'cisco.wd5.myworkdayjobs.com',           name: 'Cisco' },
  { slug: 'dell',            domain: 'dell.wd1.myworkdayjobs.com',            name: 'Dell Technologies',   careerSite: 'ExternalNonPublic' },
  { slug: 'hpe',             domain: 'hpe.wd5.myworkdayjobs.com',             name: 'HPE' },
  { slug: 'intel',           domain: 'intel.wd1.myworkdayjobs.com',           name: 'Intel' },
  { slug: 'amd',             domain: 'amd.wd5.myworkdayjobs.com',             name: 'AMD' },
  { slug: 'vertiv',          domain: 'vertiv.wd1.myworkdayjobs.com',          name: 'Vertiv' },
  { slug: 'fortinet',        domain: 'fortinet.wd3.myworkdayjobs.com',        name: 'Fortinet' },
  { slug: 'f5',              domain: 'f5.wd5.myworkdayjobs.com',              name: 'F5 Networks' },
  { slug: 'extremenetworks', domain: 'extremenetworks.wd5.myworkdayjobs.com', name: 'Extreme Networks' },
  { slug: 'equinix',         domain: 'equinix.wd1.myworkdayjobs.com',         name: 'Equinix' },
  { slug: 'marvell',         domain: 'marvell.wd1.myworkdayjobs.com',         name: 'Marvell (Workday)' },
  { slug: 'micron',          domain: 'micron.wd1.myworkdayjobs.com',          name: 'Micron Technology' },
  { slug: 'seagate',         domain: 'seagate.wd1.myworkdayjobs.com',         name: 'Seagate' },
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
        allJobs.push(...await scrapeGreenhouseJobs(co.ats_slug, co.name));
      } else if (co.careers_url) {
        allJobs.push(...await scrapePlainWebsite(co.careers_url, co.name));
      }
    }

    for (const co of HARDCODED_WORKDAY) {
      allJobs.push(...await scrapeWorkdayJobs(co.slug, co.domain, co.name, co.careerSite));
    }

    console.log(`\nTotal scraped: ${allJobs.length} listings`);

    const filtered = allJobs.filter((j) => SALES_INCLUDE.test(j.title) && !SALES_EXCLUDE.test(j.title));
    const toScore = filtered.slice(0, 100);
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
        `INSERT INTO jobs (scout_run_id, title, company, location, salary, apply_url, why_good_fit, match_score, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [runId, m.title, m.company, m.location, m.salary ?? null, m.applyUrl, m.whyGoodFit, m.matchScore, m.source]
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

// ── Scheduler ─────────────────────────────────────────────────────────────
let lastAutoRunDate = '';
setInterval(async () => {
  if (scoutRunning) return;
  try {
    const { rows } = await pool.query('SELECT schedule_time FROM criteria LIMIT 1');
    const scheduleTime = rows[0]?.schedule_time as string | null;
    if (!scheduleTime) return;
    const now = new Date();
    const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const today = now.toDateString();
    if (hhmm === scheduleTime && today !== lastAutoRunDate) {
      lastAutoRunDate = today;
      console.log(`[Scheduler] Auto-running scout at ${scheduleTime}`);
      const { rows: runRows } = await pool.query("INSERT INTO scout_runs (status, jobs_found) VALUES ('running', 0) RETURNING *");
      const runId = (runRows[0] as { id: number }).id;
      scoutRunning = true;
      runScoutInBackground(runId).catch(console.error).finally(() => { scoutRunning = false; });
    }
  } catch { /* ignore scheduler errors */ }
}, 60000);

// ── HTML dashboard ────────────────────────────────────────────────────────

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
// Listen immediately so Replit health checks pass before DB init completes
app.listen(PORT, () => {
  console.log(`Job Scout Agent listening on port ${PORT}`);
});

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is not set.');
  process.exit(1);
}

initDb()
  .then(() => { console.log('Database initialized'); })
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
:root{
  --bg:#0a0a0b;--surface:#111114;--surface2:#18181d;--border:#1e1e26;
  --text:#e8e6e0;--muted:#6b6b7a;--gold:#c8a96e;--gold-dim:#8a7045;
  --green:#4caf88;--red:#cf6679;--blue:#5b8dee;--r:10px
}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:14px;line-height:1.5;min-height:100vh}

/* ── header ── */
header{border-bottom:1px solid var(--border);padding:14px 24px;display:flex;align-items:center;gap:12px;background:var(--surface);position:sticky;top:0;z-index:100}
.logo{font-size:16px;font-weight:700;color:var(--gold);letter-spacing:-0.02em;white-space:nowrap}
.hdr-meta{font-size:12px;color:var(--muted);margin-left:8px}
.hdr-right{display:flex;align-items:center;gap:10px;margin-left:auto}
.dot{width:8px;height:8px;border-radius:50%;background:var(--green);flex-shrink:0;transition:background .3s}
.dot.running{background:var(--gold);animation:pulse 1s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.35}}

/* ── buttons ── */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:7px;font-size:13px;font-weight:600;border:none;cursor:pointer;transition:opacity .15s,transform .1s;text-decoration:none;white-space:nowrap}
.btn:hover:not(:disabled){opacity:.82;transform:translateY(-1px)}
.btn:active:not(:disabled){transform:translateY(0)}
.btn:disabled{opacity:.35;cursor:not-allowed}
.btn-gold{background:var(--gold);color:#0a0a0b}
.btn-ghost{background:transparent;color:var(--text);border:1px solid var(--border)}
.btn-ghost:hover:not(:disabled){background:var(--surface2);border-color:var(--gold)}
.btn-danger{background:transparent;color:var(--red);border:1px solid #3a1520}
.btn-danger:hover:not(:disabled){background:#1a0810}
.btn-sm{padding:6px 12px;font-size:12px}
.run-msg{font-size:12px;color:var(--muted)}

/* ── stats bar ── */
.stats-bar{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;border-bottom:1px solid var(--border);background:var(--border)}
.stat-card{background:var(--surface);padding:16px 24px;display:flex;flex-direction:column;gap:4px}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}
.stat-value{font-size:24px;font-weight:700;color:var(--text);letter-spacing:-0.02em;line-height:1.2}
.stat-value.gold{color:var(--gold)}
.stat-value.green{color:var(--green)}
.stat-sub{font-size:11px;color:var(--muted)}
@media(max-width:700px){.stats-bar{grid-template-columns:repeat(2,1fr)}}

/* ── tabs ── */
.tabs{display:flex;gap:0;padding:0 24px;border-bottom:1px solid var(--border);background:var(--surface);overflow-x:auto}
.tab{padding:12px 16px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;user-select:none;white-space:nowrap;transition:color .15s}
.tab.active{color:var(--text);border-color:var(--gold)}
.tab:hover:not(.active){color:var(--text)}
.panel{display:none;padding:24px;max-width:1400px;margin:0 auto}
.panel.active{display:block}

/* ── jobs grid ── */
.jobs-header{display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap}
.jobs-count{font-size:13px;color:var(--muted)}
.jobs-count strong{color:var(--text)}
.jobs-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
@media(max-width:760px){.jobs-grid{grid-template-columns:1fr}}

/* ── job card ── */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--r);overflow:hidden;display:flex;flex-direction:column;transition:border-color .2s,box-shadow .2s}
.card:hover{border-color:var(--gold-dim);box-shadow:0 4px 24px rgba(200,169,110,.08)}
.card-score{padding:14px 16px 12px;border-bottom:1px solid var(--border)}
.score-row{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.score-label{font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em}
.score-val{font-size:15px;font-weight:700;color:var(--gold)}
.score-bar-bg{height:4px;background:#1e1e26;border-radius:2px;overflow:hidden}
.score-bar-fg{height:4px;background:linear-gradient(90deg,var(--gold-dim),var(--gold));border-radius:2px;transition:width .6s ease}
.card-body{padding:14px 16px;flex:1}
.job-title{font-size:15px;font-weight:700;color:var(--text);margin-bottom:3px;line-height:1.3}
.job-company{font-size:13px;color:var(--gold);font-weight:600;margin-bottom:10px}
.job-meta{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.meta-chip{font-size:11px;color:var(--muted);display:flex;align-items:center;gap:4px}
.source-badge{font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;text-transform:uppercase;letter-spacing:.06em}
.src-greenhouse{background:#0d2015;color:#4caf88}
.src-workday{background:#0d1a2a;color:#5b8dee}
.src-web{background:#1a1020;color:#9b7ecc}
.src-lever{background:#2a1a0a;color:#c8a96e}
.why-fit{font-size:12px;color:#888;line-height:1.65;display:-webkit-box;-webkit-line-clamp:4;-webkit-box-orient:vertical;overflow:hidden}
.card-foot{padding:12px 16px;border-top:1px solid var(--border);display:flex;gap:8px;flex-wrap:wrap}

/* ── empty state ── */
.empty-state{padding:64px 24px;text-align:center;color:var(--muted)}
.empty-icon{font-size:48px;margin-bottom:16px;opacity:.4}
.empty-title{font-size:16px;font-weight:600;color:var(--text);margin-bottom:8px}
.empty-desc{font-size:13px;line-height:1.6}

/* ── run history table ── */
.tbl-wrap{overflow-x:auto}
.tbl{width:100%;border-collapse:collapse}
.tbl th{text-align:left;padding:10px 14px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;border-bottom:1px solid var(--border);font-weight:600}
.tbl td{padding:12px 14px;font-size:13px;border-bottom:1px solid #111117;vertical-align:top}
.tbl tr:hover td{background:rgba(255,255,255,.015)}
.badge{display:inline-block;padding:3px 9px;border-radius:5px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.b-running{background:#2a2010;color:var(--gold)}
.b-completed{background:#0d2318;color:var(--green)}
.b-failed{background:#2a1018;color:var(--red)}

/* ── settings ── */
.settings-layout{display:grid;grid-template-columns:200px 1fr;gap:0;min-height:400px}
.settings-nav{border-right:1px solid var(--border);padding:8px 0}
.snav-item{padding:9px 16px;font-size:13px;color:var(--muted);cursor:pointer;border-radius:0;transition:color .15s,background .15s;display:flex;align-items:center;gap:8px}
.snav-item.active{color:var(--text);background:rgba(200,169,110,.08)}
.snav-item:hover:not(.active){color:var(--text);background:rgba(255,255,255,.03)}
.settings-content{padding:24px 32px}
.settings-section{display:none}
.settings-section.active{display:block}
.section-title{font-size:16px;font-weight:700;color:var(--text);margin-bottom:4px}
.section-desc{font-size:13px;color:var(--muted);margin-bottom:20px}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:780px}
.form-grid.single{grid-template-columns:1fr}
@media(max-width:640px){.form-grid{grid-template-columns:1fr}.settings-layout{grid-template-columns:1fr}}
.fg{display:flex;flex-direction:column;gap:6px}
.fg.full{grid-column:1/-1}
label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;font-weight:600}
textarea,input,select{background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:9px 12px;font-size:13px;font-family:inherit;resize:vertical;outline:none;width:100%;transition:border-color .15s}
textarea:focus,input:focus,select:focus{border-color:var(--gold)}
select option{background:var(--surface2)}
.hint{font-size:11px;color:var(--muted)}
.form-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:20px}
.ok-msg{font-size:12px;color:var(--green);font-weight:600}
.err-msg{font-size:12px;color:var(--red)}

/* ── gmail status ── */
.gmail-card{background:var(--surface2);border:1px solid var(--border);border-radius:var(--r);padding:20px;max-width:520px;margin-bottom:20px}
.gmail-connected{display:flex;align-items:center;gap:12px}
.gmail-icon{width:40px;height:40px;border-radius:50%;background:#1a2a1a;display:flex;align-items:center;justify-content:center;font-size:20px}
.gmail-email{font-size:14px;font-weight:600;color:var(--text)}
.gmail-status-label{font-size:12px;color:var(--green)}

/* ── companies ── */
.companies-wrap{max-width:680px}
.company-row{display:flex;align-items:center;gap:12px;padding:12px 16px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;margin-bottom:8px}
.company-name{font-weight:700;flex:1;font-size:14px}
.company-meta{font-size:12px;color:var(--muted)}
.company-badge{font-size:10px;font-weight:600;padding:2px 7px;border-radius:4px;text-transform:uppercase}
.add-company-form{display:grid;grid-template-columns:1fr 130px 1fr;gap:10px;margin-top:16px}
@media(max-width:600px){.add-company-form{grid-template-columns:1fr}}

/* ── modal ── */
.modal-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:1000;align-items:center;justify-content:center;padding:20px}
.modal-overlay.open{display:flex}
.modal{background:var(--surface);border:1px solid var(--border);border-radius:14px;width:100%;max-width:760px;max-height:90vh;display:flex;flex-direction:column;overflow:hidden}
.modal-header{display:flex;align-items:flex-start;gap:16px;padding:20px 24px;border-bottom:1px solid var(--border)}
.modal-title{flex:1}
.modal-title h3{font-size:16px;font-weight:700;margin-bottom:2px}
.modal-title .modal-subtitle{font-size:12px;color:var(--muted)}
.modal-close{background:none;border:none;color:var(--muted);font-size:20px;cursor:pointer;padding:4px 8px;line-height:1;border-radius:6px}
.modal-close:hover{background:var(--surface2);color:var(--text)}
.modal-tabs{display:flex;gap:0;padding:0 24px;border-bottom:1px solid var(--border)}
.mtab{padding:10px 16px;font-size:13px;font-weight:500;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.mtab.active{color:var(--text);border-color:var(--gold)}
.modal-body{flex:1;overflow-y:auto;padding:20px 24px}
.modal-panel{display:none}
.modal-panel.active{display:block}
.tailor-loading{display:flex;align-items:center;gap:12px;padding:40px;color:var(--muted)}
.spinner{width:20px;height:20px;border:2px solid var(--border);border-top-color:var(--gold);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
.tailor-pre{background:var(--surface2);border:1px solid var(--border);border-radius:8px;padding:16px;font-size:12px;font-family:'SF Mono',Monaco,'Cascadia Code',monospace;white-space:pre-wrap;line-height:1.7;color:#ccc;max-height:400px;overflow-y:auto}
.modal-footer{padding:16px 24px;border-top:1px solid var(--border);display:flex;align-items:center;gap:10px}
.copy-hint{font-size:12px;color:var(--muted)}

/* ── toast ── */
.toast{position:fixed;bottom:24px;right:24px;background:#1a2a1a;border:1px solid #2a4a2a;color:var(--green);padding:12px 20px;border-radius:9px;font-size:13px;font-weight:600;z-index:2000;opacity:0;transform:translateY(8px);transition:all .25s;pointer-events:none}
.toast.show{opacity:1;transform:translateY(0)}
.toast.err{background:#2a1018;border-color:#4a1a28;color:var(--red)}
</style>
</head>
<body>

<!-- ── HEADER ── -->
<header>
  <span class="logo">&#x2B21; Job Scout Agent</span>
  <span class="hdr-meta" id="hdr-last-run"></span>
  <div class="hdr-right">
    <span class="dot" id="dot"></span>
    <span class="run-msg" id="run-msg"></span>
    <button class="btn btn-gold" id="run-btn" onclick="runScout()">&#9654; Run Scout Now</button>
  </div>
</header>

<!-- ── STATS BAR ── -->
<div class="stats-bar">
  <div class="stat-card">
    <div class="stat-label">Total Jobs Scanned</div>
    <div class="stat-value" id="s-total">&#x2014;</div>
    <div class="stat-sub">all time</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Matches Today</div>
    <div class="stat-value green" id="s-today">&#x2014;</div>
    <div class="stat-sub">score &ge; 60</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Top Match Score</div>
    <div class="stat-value gold" id="s-top">&#x2014;</div>
    <div class="stat-sub">today</div>
  </div>
  <div class="stat-card">
    <div class="stat-label">Next Scheduled Run</div>
    <div class="stat-value" id="s-next" style="font-size:18px">&#x2014;</div>
    <div class="stat-sub">daily</div>
  </div>
</div>

<!-- ── TABS ── -->
<div class="tabs">
  <div class="tab active" id="tab-jobs"     onclick="showTab('jobs')">Jobs</div>
  <div class="tab"        id="tab-runs"     onclick="showTab('runs')">Run History</div>
  <div class="tab"        id="tab-settings" onclick="showTab('settings')">Settings</div>
</div>

<!-- ── JOBS PANEL ── -->
<div class="panel active" id="panel-jobs">
  <div class="jobs-header">
    <div class="jobs-count" id="jobs-count">Loading&hellip;</div>
    <button class="btn btn-ghost btn-sm" onclick="sendDigest()" id="digest-btn">&#x2709; Email Digest</button>
  </div>
  <div class="jobs-grid" id="jobs-grid"></div>
</div>

<!-- ── RUN HISTORY PANEL ── -->
<div class="panel" id="panel-runs">
  <div class="tbl-wrap">
    <table class="tbl">
      <thead><tr>
        <th>#</th><th>Status</th><th>Jobs Found</th><th>Started</th><th>Completed</th><th>Email</th><th>Error</th>
      </tr></thead>
      <tbody id="runs-body"></tbody>
    </table>
    <div class="empty-state" id="runs-empty" style="display:none">
      <div class="empty-icon">&#x23F1;</div>
      <div class="empty-title">No scout runs yet</div>
      <div class="empty-desc">Click &ldquo;Run Scout Now&rdquo; to find your first matches.</div>
    </div>
  </div>
</div>

<!-- ── SETTINGS PANEL ── -->
<div class="panel" id="panel-settings">
  <div class="settings-layout">
    <div class="settings-nav">
      <div class="snav-item active" id="snav-resume"   onclick="showSettings('resume')">&#x1F4C4; Resume</div>
      <div class="snav-item"        id="snav-gmail"    onclick="showSettings('gmail')">&#x2709; Gmail</div>
      <div class="snav-item"        id="snav-schedule" onclick="showSettings('schedule')">&#x23F0; Schedule</div>
      <div class="snav-item"        id="snav-criteria" onclick="showSettings('criteria')">&#x1F3AF; Criteria</div>
      <div class="snav-item"        id="snav-companies" onclick="showSettings('companies')">&#x1F3E2; Companies</div>
    </div>

    <div class="settings-content">

      <!-- Resume -->
      <div class="settings-section active" id="sec-resume">
        <div class="section-title">Base Resume</div>
        <div class="section-desc">Paste your full resume here. It will be used to generate tailored versions for each job.</div>
        <div class="fg full" style="max-width:780px">
          <label>Resume Content</label>
          <textarea id="resume-text" rows="22" placeholder="Paste your resume text here..."></textarea>
        </div>
        <div class="form-row">
          <button class="btn btn-gold" onclick="saveResume()">Save Resume</button>
          <span class="ok-msg" id="resume-saved-msg" style="display:none">&#x2713; Saved</span>
        </div>
      </div>

      <!-- Gmail -->
      <div class="settings-section" id="sec-gmail">
        <div class="section-title">Gmail Connection</div>
        <div class="section-desc">Connect Gmail to receive daily job digest emails and send tailored applications.</div>
        <div class="gmail-card" id="gmail-card">
          <div id="gmail-disconnected">
            <div style="font-size:14px;color:var(--muted);margin-bottom:16px">No Gmail account connected.</div>
            <button class="btn btn-gold" onclick="connectGmail()">&#x1F517; Connect Gmail</button>
            <div style="font-size:11px;color:var(--muted);margin-top:12px">Requires GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET environment variables.</div>
          </div>
          <div id="gmail-connected" style="display:none">
            <div class="gmail-connected">
              <div class="gmail-icon">&#x2709;</div>
              <div>
                <div class="gmail-email" id="gmail-email-text"></div>
                <div class="gmail-status-label">&#x2713; Connected</div>
              </div>
              <button class="btn btn-danger btn-sm" onclick="disconnectGmail()" style="margin-left:auto">Disconnect</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Schedule -->
      <div class="settings-section" id="sec-schedule">
        <div class="section-title">Daily Schedule</div>
        <div class="section-desc">Set a time for Job Scout to automatically scan and optionally email you a digest.</div>
        <div class="form-grid single" style="max-width:400px">
          <div class="fg">
            <label>Run Time (local server time)</label>
            <input type="time" id="schedule-input" placeholder="HH:MM">
            <span class="hint">Leave blank to disable automatic runs</span>
          </div>
        </div>
        <div class="form-row">
          <button class="btn btn-gold" onclick="saveSchedule()">Save Schedule</button>
          <span class="ok-msg" id="schedule-saved-msg" style="display:none">&#x2713; Saved</span>
        </div>
      </div>

      <!-- Criteria -->
      <div class="settings-section" id="sec-criteria">
        <div class="section-title">Job Criteria</div>
        <div class="section-desc">Define what makes a great match. Claude scores every job against these rules.</div>
        <form onsubmit="saveCriteria(event)">
          <div class="form-grid">
            <div class="fg"><label>Your Name</label><input type="text" id="c-name" placeholder="Jane Smith"></div>
            <div class="fg"><label>Your Email</label><input type="email" id="c-email" placeholder="jane@example.com"></div>
            <div class="fg"><label>Min Base Salary</label><input type="number" id="c-salary" placeholder="150000"></div>
            <div class="fg"></div>
            <div class="fg"><label>Target Roles</label><textarea id="c-roles" rows="5" placeholder="One per line&#10;Enterprise Account Executive&#10;Strategic Account Executive"></textarea><span class="hint">One role per line</span></div>
            <div class="fg"><label>Industries</label><textarea id="c-industries" rows="5" placeholder="One per line&#10;AI Infrastructure&#10;Data Center Hardware"></textarea></div>
            <div class="fg"><label>Locations</label><textarea id="c-locations" rows="4" placeholder="One per line&#10;Remote&#10;New York"></textarea></div>
            <div class="fg"><label>Must Have</label><textarea id="c-musthave" rows="4" placeholder="One per line&#10;enterprise sales&#10;quota carrying"></textarea></div>
            <div class="fg"><label>Nice To Have</label><textarea id="c-nicetohave" rows="4" placeholder="One per line&#10;AI&#10;data center"></textarea></div>
            <div class="fg"><label>Avoid</label><textarea id="c-avoid" rows="4" placeholder="One per line&#10;SDR&#10;BDR&#10;SMB only"></textarea></div>
          </div>
          <div class="form-row">
            <button type="submit" class="btn btn-gold">Save Criteria</button>
            <span class="ok-msg" id="criteria-saved-msg" style="display:none">&#x2713; Saved</span>
          </div>
        </form>
      </div>

      <!-- Companies -->
      <div class="settings-section" id="sec-companies">
        <div class="section-title">Company List</div>
        <div class="section-desc">Greenhouse and Workday companies are pre-configured. Add custom companies here.</div>
        <div class="companies-wrap">
          <div id="company-list"></div>
          <div style="margin-top:20px">
            <div style="font-size:12px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:10px">Add Custom Company</div>
            <div class="add-company-form">
              <div class="fg"><label>Company Name</label><input type="text" id="co-name" placeholder="Acme Corp"></div>
              <div class="fg">
                <label>ATS Type</label>
                <select id="co-type">
                  <option value="greenhouse">Greenhouse</option>
                  <option value="lever">Lever</option>
                  <option value="other">Plain URL</option>
                </select>
              </div>
              <div class="fg"><label>Slug or URL</label><input type="text" id="co-slug" placeholder="companyname or https://..."></div>
            </div>
            <div style="margin-top:10px">
              <button class="btn btn-gold" onclick="addCompany()">Add Company</button>
            </div>
          </div>
        </div>
      </div>

    </div><!-- end settings-content -->
  </div><!-- end settings-layout -->
</div>

<!-- ── TAILOR RESUME MODAL ── -->
<div class="modal-overlay" id="tailor-overlay" onclick="closeTailorModal(event)">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-header">
      <div class="modal-title">
        <h3>&#x2728; Tailored Resume &amp; Cover Letter</h3>
        <div class="modal-subtitle" id="tailor-job-label"></div>
      </div>
      <button class="modal-close" onclick="closeTailorModal(null)">&#x00D7;</button>
    </div>
    <div class="modal-tabs">
      <div class="mtab active" id="mtab-resume" onclick="showModalTab('resume')">Resume</div>
      <div class="mtab"        id="mtab-cover"  onclick="showModalTab('cover')">Cover Letter</div>
    </div>
    <div class="modal-body">
      <div class="tailor-loading" id="tailor-loading">
        <div class="spinner"></div>
        <span>Claude is tailoring your resume&hellip;</span>
      </div>
      <div class="modal-panel active" id="mpanel-resume">
        <pre class="tailor-pre" id="tailor-resume-text"></pre>
      </div>
      <div class="modal-panel" id="mpanel-cover">
        <pre class="tailor-pre" id="tailor-cover-text"></pre>
      </div>
    </div>
    <div class="modal-footer" id="tailor-footer" style="display:none">
      <button class="btn btn-gold btn-sm" onclick="copyTailorContent()">&#x1F4CB; Copy</button>
      <span class="copy-hint">Copies whichever tab is active</span>
    </div>
  </div>
</div>

<!-- ── TOAST ── -->
<div class="toast" id="toast"></div>

<script>
// ── utils ──────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function lines(id) {
  return document.getElementById(id).value.split('\\n').map(function(s){return s.trim();}).filter(Boolean);
}
function toast(msg, isErr) {
  var t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '') + ' show';
  setTimeout(function(){ t.className = 'toast' + (isErr ? ' err' : ''); }, 3000);
}

// ── tabs ──────────────────────────────────────────────────────────────────
var TABS = ['jobs','runs','settings'];
function showTab(name) {
  TABS.forEach(function(t) {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('panel-' + t).classList.toggle('active', t === name);
  });
  if (name === 'runs') loadRuns();
  if (name === 'settings') { loadSettings(); }
}

// ── settings sub-nav ──────────────────────────────────────────────────────
var SNAV = ['resume','gmail','schedule','criteria','companies'];
function showSettings(name) {
  SNAV.forEach(function(s) {
    document.getElementById('snav-' + s).classList.toggle('active', s === name);
    document.getElementById('sec-' + s).classList.toggle('active', s === name);
  });
  if (name === 'criteria') loadCriteria();
  if (name === 'companies') loadCompanies();
  if (name === 'gmail') loadGmailStatus();
  if (name === 'schedule') loadSchedule();
  if (name === 'resume') loadResume();
}

function loadSettings() {
  var active = document.querySelector('.snav-item.active');
  var name = active ? active.id.replace('snav-', '') : 'resume';
  showSettings(name);
}

// ── stats ─────────────────────────────────────────────────────────────────
async function loadStats() {
  try {
    var res = await fetch('/api/stats');
    var s = await res.json();
    document.getElementById('s-total').textContent = (s.total_jobs || 0).toLocaleString();
    document.getElementById('s-today').textContent = (s.matches_today || 0).toLocaleString();
    document.getElementById('s-top').textContent   = s.top_score_today != null ? s.top_score_today + '/100' : '\u2014';
    document.getElementById('s-next').textContent  = s.schedule_time || 'Not set';
    if (s.last_run) {
      var lbl = 'Last run: ' + new Date(s.last_run).toLocaleString();
      document.getElementById('hdr-last-run').textContent = lbl;
      document.getElementById('dot').className = 'dot' + (s.last_run_status === 'running' ? ' running' : '');
    }
  } catch(e) {}
}

// ── jobs ──────────────────────────────────────────────────────────────────
async function loadJobs() {
  try {
    var res  = await fetch('/api/jobs');
    var jobs = await res.json();
    var grid = document.getElementById('jobs-grid');
    var cnt  = document.getElementById('jobs-count');
    if (!jobs.length) {
      cnt.innerHTML = '<strong>0</strong> jobs found yet';
      grid.innerHTML =
        '<div class="empty-state" style="grid-column:1/-1">' +
          '<div class="empty-icon">&#x1F50D;</div>' +
          '<div class="empty-title">No matches yet</div>' +
          '<div class="empty-desc">Click &ldquo;Run Scout Now&rdquo; to scan ' +
          'job boards and find matches.</div>' +
        '</div>';
      return;
    }
    cnt.innerHTML = '<strong>' + jobs.length + '</strong> job' + (jobs.length !== 1 ? 's' : '') + ' found';
    var html = '';
    jobs.forEach(function(j) {
      var srcCls = 'src-' + (j.source || 'web').toLowerCase();
      var scoreColor = j.match_score >= 85 ? 'var(--green)' : j.match_score >= 70 ? 'var(--gold)' : 'var(--muted)';
      html +=
        '<div class="card">' +
          '<div class="card-score">' +
            '<div class="score-row">' +
              '<span class="score-label">Match Score</span>' +
              '<span class="score-val" style="color:' + scoreColor + '">' + esc(j.match_score) + ' / 100</span>' +
            '</div>' +
            '<div class="score-bar-bg"><div class="score-bar-fg" style="width:' + Math.min(100,j.match_score) + '%;background:' + scoreColor + '"></div></div>' +
          '</div>' +
          '<div class="card-body">' +
            '<div class="job-title">' + esc(j.title) + '</div>' +
            '<div class="job-company">' + esc(j.company) + '</div>' +
            '<div class="job-meta">' +
              '<span class="meta-chip">&#x1F4CD; ' + esc(j.location) + '</span>' +
              (j.salary ? '<span class="meta-chip">&#x1F4B0; ' + esc(j.salary) + '</span>' : '') +
              '<span class="source-badge ' + srcCls + '">' + esc(j.source || 'Web') + '</span>' +
            '</div>' +
            (j.why_good_fit ? '<div class="why-fit">' + esc(j.why_good_fit) + '</div>' : '') +
          '</div>' +
          '<div class="card-foot">' +
            '<a href="' + esc(j.apply_url) + '" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">View Posting &#x2192;</a>' +
            '<button class="btn btn-gold btn-sm" onclick="tailorResume(' + j.id + ',\'' + esc(j.title) + '\',\'' + esc(j.company) + '\')">&#x2728; Tailor Resume</button>' +
          '</div>' +
        '</div>';
    });
    grid.innerHTML = html;
  } catch(e) { console.error(e); }
}

// ── runs ──────────────────────────────────────────────────────────────────
async function loadRuns() {
  try {
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
          '<td style="color:var(--muted)">#' + esc(r.id) + '</td>' +
          '<td><span class="badge b-' + esc(r.status) + '">' + esc(r.status) + '</span></td>' +
          '<td style="font-weight:600">' + esc(r.jobs_found) + '</td>' +
          '<td style="color:var(--muted)">' + (r.started_at   ? new Date(r.started_at).toLocaleString()   : '\u2014') + '</td>' +
          '<td style="color:var(--muted)">' + (r.completed_at ? new Date(r.completed_at).toLocaleString() : '\u2014') + '</td>' +
          '<td>' + (r.email_sent ? '<span style="color:var(--green)">&#x2713; Sent</span>' : '<span style="color:var(--muted)">\u2014</span>') + '</td>' +
          '<td style="color:var(--red);font-size:12px">' + esc(r.error || '') + '</td>' +
        '</tr>';
    });
    tbody.innerHTML = html;
    var latest = runs[0];
    if (latest) {
      document.getElementById('dot').className = 'dot' + (latest.status === 'running' ? ' running' : '');
      if (latest.started_at) {
        document.getElementById('hdr-last-run').textContent = 'Last run: ' + new Date(latest.started_at).toLocaleString();
      }
    }
  } catch(e) {}
}

// ── criteria ──────────────────────────────────────────────────────────────
async function loadCriteria() {
  try {
    var res = await fetch('/api/criteria');
    var c   = await res.json();
    document.getElementById('c-name').value       = c.your_name   || '';
    document.getElementById('c-email').value      = c.your_email  || '';
    document.getElementById('c-salary').value     = c.min_salary  || '';
    document.getElementById('c-roles').value      = (c.target_roles  || []).join('\\n');
    document.getElementById('c-industries').value = (c.industries    || []).join('\\n');
    document.getElementById('c-locations').value  = (c.locations     || []).join('\\n');
    document.getElementById('c-musthave').value   = (c.must_have     || []).join('\\n');
    document.getElementById('c-nicetohave').value = (c.nice_to_have  || []).join('\\n');
    document.getElementById('c-avoid').value      = (c.avoid         || []).join('\\n');
  } catch(e) {}
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
  try {
    await fetch('/api/criteria', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    var msg = document.getElementById('criteria-saved-msg');
    msg.style.display = '';
    setTimeout(function(){ msg.style.display = 'none'; }, 2500);
    toast('Criteria saved');
  } catch(e) { toast('Save failed', true); }
}

// ── schedule ──────────────────────────────────────────────────────────────
async function loadSchedule() {
  try {
    var res = await fetch('/api/criteria');
    var c = await res.json();
    document.getElementById('schedule-input').value = c.schedule_time || '';
  } catch(e) {}
}
async function saveSchedule() {
  var time = document.getElementById('schedule-input').value || null;
  try {
    var res = await fetch('/api/criteria');
    var c = await res.json();
    c.schedule_time = time;
    await fetch('/api/criteria', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify(c) });
    document.getElementById('s-next').textContent = time || 'Not set';
    var msg = document.getElementById('schedule-saved-msg');
    msg.style.display = '';
    setTimeout(function(){ msg.style.display = 'none'; }, 2500);
    toast('Schedule saved');
  } catch(e) { toast('Save failed', true); }
}

// ── resume ────────────────────────────────────────────────────────────────
async function loadResume() {
  try {
    var res = await fetch('/api/resume');
    var data = await res.json();
    document.getElementById('resume-text').value = data.content || '';
  } catch(e) {}
}
async function saveResume() {
  var content = document.getElementById('resume-text').value;
  try {
    await fetch('/api/resume', { method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ content: content }) });
    var msg = document.getElementById('resume-saved-msg');
    msg.style.display = '';
    setTimeout(function(){ msg.style.display = 'none'; }, 2500);
    toast('Resume saved');
  } catch(e) { toast('Save failed', true); }
}

// ── gmail ─────────────────────────────────────────────────────────────────
async function loadGmailStatus() {
  try {
    var res = await fetch('/api/gmail/status');
    var data = await res.json();
    document.getElementById('gmail-disconnected').style.display = data.connected ? 'none' : '';
    document.getElementById('gmail-connected').style.display    = data.connected ? '' : 'none';
    if (data.connected) {
      document.getElementById('gmail-email-text').textContent = data.email || '';
    }
  } catch(e) {}
}
async function connectGmail() {
  try {
    var res  = await fetch('/api/gmail/setup-url');
    var data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    window.location.href = data.url;
  } catch(e) { toast('Failed to get Gmail auth URL', true); }
}
async function disconnectGmail() {
  if (!confirm('Disconnect Gmail?')) return;
  try {
    await fetch('/api/gmail/disconnect', { method:'POST' });
    loadGmailStatus();
    toast('Gmail disconnected');
  } catch(e) { toast('Failed', true); }
}

// ── companies ─────────────────────────────────────────────────────────────
async function loadCompanies() {
  try {
    var res = await fetch('/api/companies');
    var cos = await res.json();
    var list = document.getElementById('company-list');
    if (!cos.length) { list.innerHTML = '<div style="color:var(--muted);font-size:13px">No companies yet.</div>'; return; }
    var html = '';
    cos.forEach(function(c) {
      var slug = c.ats_slug || c.careers_url || '';
      var badgeCls = c.ats_type === 'greenhouse' ? 'src-greenhouse' : c.ats_type === 'lever' ? 'src-lever' : 'src-web';
      html +=
        '<div class="company-row">' +
          '<span class="source-badge ' + badgeCls + '">' + esc(c.ats_type) + '</span>' +
          '<span class="company-name">' + esc(c.name) + '</span>' +
          '<span class="company-meta">' + esc(slug) + '</span>' +
          '<button class="btn btn-ghost btn-sm" onclick="deleteCompany(' + esc(c.id) + ')">Remove</button>' +
        '</div>';
    });
    list.innerHTML = html;
  } catch(e) {}
}
async function addCompany() {
  var name = document.getElementById('co-name').value.trim();
  var type = document.getElementById('co-type').value;
  var slug = document.getElementById('co-slug').value.trim();
  if (!name || !slug) { toast('Name and slug/URL are required', true); return; }
  var body = { name: name, ats_type: type };
  if (type === 'other') { body.careers_url = slug; } else { body.ats_slug = slug; }
  try {
    await fetch('/api/companies', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    document.getElementById('co-name').value = '';
    document.getElementById('co-slug').value = '';
    loadCompanies();
    toast('Company added');
  } catch(e) { toast('Failed to add company', true); }
}
async function deleteCompany(id) {
  try {
    await fetch('/api/companies/' + id, { method:'DELETE' });
    loadCompanies();
    toast('Company removed');
  } catch(e) {}
}

// ── run scout ─────────────────────────────────────────────────────────────
var pollTimer = null;
async function runScout() {
  var btn = document.getElementById('run-btn');
  var msg = document.getElementById('run-msg');
  btn.disabled = true;
  msg.textContent = 'Starting\u2026';
  try {
    var res = await fetch('/api/scout/run', { method:'POST' });
    if (!res.ok) {
      var d = await res.json();
      msg.textContent = d.error || 'Error';
      btn.disabled = false;
      return;
    }
    document.getElementById('dot').className = 'dot running';
    msg.textContent = 'Scanning job boards\u2026';
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async function() {
      try {
        var r    = await fetch('/api/scout/status');
        var runs = await r.json();
        var latest = runs[0];
        if (!latest) return;
        if (latest.status !== 'running') {
          clearInterval(pollTimer); pollTimer = null;
          btn.disabled = false;
          document.getElementById('dot').className = 'dot';
          if (latest.status === 'completed') {
            msg.textContent = 'Done! Found ' + latest.jobs_found + ' match' + (latest.jobs_found !== 1 ? 'es' : '');
            loadJobs();
            loadStats();
            toast('Scout complete \u2014 ' + latest.jobs_found + ' matches found');
          } else {
            msg.textContent = 'Run failed: ' + (latest.error || 'unknown error');
            toast('Scout run failed', true);
          }
        }
      } catch(e) {}
    }, 2000);
  } catch(e) {
    msg.textContent = 'Error';
    btn.disabled = false;
  }
}

// ── email digest ──────────────────────────────────────────────────────────
async function sendDigest() {
  try {
    var res  = await fetch('/api/gmail/send-digest', { method:'POST' });
    var data = await res.json();
    if (data.error) { toast(data.error, true); return; }
    toast('Digest sent to ' + data.to);
  } catch(e) { toast('Failed to send digest', true); }
}

// ── tailor resume modal ────────────────────────────────────────────────────
var currentTailorTab = 'resume';
var tailorData = null;

async function tailorResume(jobId, title, company) {
  tailorData = null;
  document.getElementById('tailor-job-label').textContent = title + ' \u2014 ' + company;
  document.getElementById('tailor-loading').style.display  = 'flex';
  document.getElementById('tailor-footer').style.display   = 'none';
  document.getElementById('mpanel-resume').classList.add('active');
  document.getElementById('mpanel-cover').classList.remove('active');
  document.getElementById('tailor-resume-text').textContent = '';
  document.getElementById('tailor-cover-text').textContent  = '';
  document.getElementById('mtab-resume').classList.add('active');
  document.getElementById('mtab-cover').classList.remove('active');
  currentTailorTab = 'resume';
  document.getElementById('tailor-overlay').classList.add('open');

  try {
    var res  = await fetch('/api/jobs/' + jobId + '/tailor', { method:'POST' });
    var data = await res.json();
    document.getElementById('tailor-loading').style.display = 'none';
    if (data.error) {
      document.getElementById('tailor-resume-text').textContent = 'Error: ' + data.error;
      return;
    }
    tailorData = data;
    document.getElementById('tailor-resume-text').textContent = data.tailoredResume || '';
    document.getElementById('tailor-cover-text').textContent  = data.coverLetter    || '';
    document.getElementById('tailor-footer').style.display = 'flex';
  } catch(e) {
    document.getElementById('tailor-loading').style.display = 'none';
    document.getElementById('tailor-resume-text').textContent = 'Error generating tailored resume. Check console.';
    console.error(e);
  }
}
function showModalTab(tab) {
  currentTailorTab = tab;
  document.getElementById('mtab-resume').classList.toggle('active', tab === 'resume');
  document.getElementById('mtab-cover').classList.toggle('active',  tab === 'cover');
  document.getElementById('mpanel-resume').classList.toggle('active', tab === 'resume');
  document.getElementById('mpanel-cover').classList.toggle('active',  tab === 'cover');
}
function closeTailorModal(e) {
  if (e && e.target !== document.getElementById('tailor-overlay')) return;
  document.getElementById('tailor-overlay').classList.remove('open');
}
function copyTailorContent() {
  if (!tailorData) return;
  var text = currentTailorTab === 'resume' ? tailorData.tailoredResume : tailorData.coverLetter;
  navigator.clipboard.writeText(text || '').then(function() {
    toast('Copied to clipboard');
  }).catch(function() {
    toast('Copy failed \u2014 try selecting the text manually', true);
  });
}

// ── handle gmail callback redirect ────────────────────────────────────────
if (window.location.search.includes('gmail=connected')) {
  history.replaceState(null, '', '/');
  showTab('settings');
  showSettings('gmail');
  toast('Gmail connected successfully');
}

// ── init ──────────────────────────────────────────────────────────────────
loadJobs();
loadStats();
loadRuns();
</script>
</body>
</html>`;
