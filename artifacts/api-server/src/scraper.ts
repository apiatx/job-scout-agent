import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

export interface ScrapedJob {
  title: string;
  company: string;
  location: string;
  salary?: string;
  applyUrl: string;
  description?: string;
}

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  location?: { name: string };
}

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string };
  descriptionPlain?: string;
}

export async function scrapeGreenhouseJobs(slug: string, companyName: string): Promise<ScrapedJob[]> {
  const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      if (attempt === 0) console.log(`Greenhouse: scanning ${slug}...`);
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        if (attempt === 0 && (response.status === 404)) {
          console.log(`Greenhouse: got ${response.status} for '${slug}', retrying in 2s...`);
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        console.log(`Greenhouse: couldn't find '${slug}' (status ${response.status})`);
        return [];
      }
      const data = (await response.json()) as { jobs?: GreenhouseJob[] };
      if (!data.jobs) return [];
      console.log(`Greenhouse: found ${data.jobs.length} jobs at ${slug}`);
      return data.jobs.map((job) => ({
        title: job.title,
        company: companyName,
        location: job.location?.name ?? 'Unknown',
        applyUrl: job.absolute_url,
      }));
    } catch (e) {
      if (attempt === 0) {
        console.log(`Greenhouse: timeout/error for '${slug}', retrying in 2s...`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      console.log(`Greenhouse error for ${slug}:`, e);
      return [];
    }
  }
  return [];
}

export async function scrapeLeverJobs(slug: string, companyName: string): Promise<ScrapedJob[]> {
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    console.log(`Lever: scanning ${slug}...`);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      console.log(`Lever: couldn't find '${slug}' (status ${response.status})`);
      return [];
    }
    const data = (await response.json()) as LeverJob[];
    console.log(`Lever: found ${data.length} jobs at ${slug}`);
    return data.map((job) => ({
      title: job.text,
      company: companyName,
      location: job.categories?.location ?? 'Unknown',
      applyUrl: job.hostedUrl,
      description: job.descriptionPlain?.slice(0, 2000),
    }));
  } catch (e) {
    console.log(`Lever error for ${slug}:`, e);
    return [];
  }
}

// ── Workday scraper — calls the Workday REST API ──────────────────────────────
interface WorkdayJob {
  title: string;
  externalPath: string;
  locationsText?: string;
  postedOn?: string;
}
interface WorkdayResponse {
  total: number;
  jobPostings: WorkdayJob[];
}

const WORKDAY_SEARCH_TERMS = [
  'account executive',
  'account manager',
  'sales manager',
  'regional sales',
  'territory sales',
  'partner manager',
  'sales executive',
  'client executive',
  'client manager',
];

export async function scrapeWorkdayJobs(
  companyName: string,
  subdomain: string,   // e.g. "nvidia.wd5.myworkdayjobs.com"
  jobBoardSlug: string // e.g. "NVIDIAExternalCareerSite"
): Promise<ScrapedJob[]> {
  // Derive the company path segment from the subdomain (first part before .wd)
  const companyPath = subdomain.split('.')[0];
  const baseUrl = `https://${subdomain}/wday/cxs/${companyPath}/${jobBoardSlug}/jobs`;

  const allJobs: Map<string, ScrapedJob> = new Map();

  for (const term of WORKDAY_SEARCH_TERMS) {
    try {
      const response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: term }),
        signal: AbortSignal.timeout(12000),
      });

      if (!response.ok) {
        if (response.status === 404 || response.status === 403 || response.status === 422) break;
        continue;
      }

      const data = (await response.json()) as WorkdayResponse;
      const postings = data.jobPostings ?? [];

      for (const job of postings) {
        if (!job.externalPath) continue;
        const applyUrl = `https://${subdomain}${job.externalPath}`;
        if (!allJobs.has(applyUrl)) {
          allJobs.set(applyUrl, {
            title: job.title,
            company: companyName,
            location: job.locationsText ?? 'Unknown',
            applyUrl,
          });
        }
      }
    } catch {
      // Timeout or network error — skip this search term
    }
    // Small delay between search terms to be respectful
    await new Promise((r) => setTimeout(r, 300));
  }

  const jobs = Array.from(allJobs.values());
  if (jobs.length > 0) {
    console.log(`Workday (${companyName}): found ${jobs.length} unique jobs across ${WORKDAY_SEARCH_TERMS.length} searches`);
  }
  return jobs;
}

// ── Proxy helpers ─────────────────────────────────────────────────────────────

/**
 * Returns whether a proxy is configured for Glassdoor/ZipRecruiter.
 * Primary source: JOBSPY_PROXY Replit Secret (env var, inherited by child processes).
 * Fallback source: proxy_url saved in Settings (criteria.proxy_url).
 * Credentials are never logged.
 */
export function proxyConfigured(settingsProxyUrl?: string): { configured: boolean; source: 'env' | 'settings' | null } {
  if (process.env.JOBSPY_PROXY?.trim()) return { configured: true,  source: 'env' };
  if (settingsProxyUrl?.trim())         return { configured: true,  source: 'settings' };
  return                                       { configured: false, source: null };
}

// ── JobSpy scraper ────────────────────────────────────────────────────────────
// Calls Python script: LinkedIn + Indeed + Glassdoor/ZipRecruiter (proxy-gated).
// Criteria passed via stdin; JOBSPY_PROXY is read from env by the Python process.
export async function runJobSpyScraper(criteria?: {
  target_roles?: string[];
  locations?: string[];
  proxy_url?: string;   // fallback if JOBSPY_PROXY Replit Secret is not set
}): Promise<Array<ScrapedJob & { source: string }>> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(scriptDir, 'jobspy_scraper.py');

  const criteriaJson = JSON.stringify({
    target_roles: criteria?.target_roles ?? [],
    locations:    criteria?.locations    ?? [],
  });

  // Determine proxy status (never log the actual URL)
  const { configured, source: proxySource } = proxyConfigured(criteria?.proxy_url);
  const activeSourceList = configured
    ? 'LinkedIn + Indeed + Glassdoor + ZipRecruiter'
    : 'LinkedIn + Indeed';

  console.log(`\n──── JOBSPY SEARCH ────────────────────────────────────────`);
  console.log(`Sources: ${activeSourceList} | concurrent workers`);
  console.log(`  Roles    : ${(criteria?.target_roles ?? []).join(', ') || '(defaults)'}`);
  console.log(`  Locations: ${(criteria?.locations ?? []).join(', ') || 'United States (national)'}`);
  console.log(`  Proxy    : ${configured ? `configured (source: ${proxySource}) — Glassdoor + ZipRecruiter enabled` : 'not configured — set JOBSPY_PROXY in Replit Secrets to unlock Glassdoor + ZipRecruiter'}`);

  // Build child process env:
  //  - Replit Secret JOBSPY_PROXY is inherited automatically via process.env
  //  - If only the Settings UI proxy_url is set (not the secret), inject it as JOBSPY_PROXY
  //    so the Python script can still use it via the same env var name
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  const settingsProxy = criteria?.proxy_url?.trim() ?? '';
  if (settingsProxy && !process.env.JOBSPY_PROXY) {
    childEnv['JOBSPY_PROXY'] = settingsProxy;  // settings fallback, not logged
  }

  return new Promise((resolvePromise) => {
    const proc = spawn('python3', [scriptPath], {
      timeout: 600_000,
      env: childEnv,
    });

    proc.stdin.write(criteriaJson);
    proc.stdin.end();

    let stdout = '';
    let scrapeSummary: Record<string, unknown> | null = null;

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;

        // Parse structured status lines emitted by the Python script
        if (line.startsWith('SCRAPE_SUMMARY: ')) {
          try {
            scrapeSummary = JSON.parse(line.slice('SCRAPE_SUMMARY: '.length));
          } catch {}
          continue; // don't log raw summary line
        }
        if (line.startsWith('PROXY_STATUS: ')) continue; // handled above

        // Suppress any line that accidentally contains the proxy URL
        // (shouldn't happen — Python masks it — but belt-and-suspenders)
        if (process.env.JOBSPY_PROXY && line.includes(process.env.JOBSPY_PROXY)) continue;

        console.log(`  [JobSpy] ${line}`);
      }
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        console.log(`JobSpy: script exited with code ${code}`);
        resolvePromise([]);
        return;
      }

      if (scrapeSummary) {
        console.log(`JobSpy: summary → ${JSON.stringify(scrapeSummary)}`);
      }
      console.log(`───────────────────────────────────────────────────────────`);

      const lines = stdout.trim().split('\n');
      const jsonLine = lines.reverse().find((l) => l.trim().startsWith('['));

      if (!jsonLine) {
        console.log(`JobSpy: no JSON output found`);
        console.log(`JobSpy: stdout preview: ${stdout.slice(0, 300)}`);
        resolvePromise([]);
        return;
      }

      try {
        const jobs = JSON.parse(jsonLine) as Array<{
          title: string; company: string; location: string;
          salary?: string; applyUrl: string; description?: string; source: string;
        }>;
        console.log(`JobSpy: received ${jobs.length} unique jobs`);
        resolvePromise(jobs.map((j) => ({
          title:       j.title,
          company:     j.company,
          location:    j.location,
          salary:      j.salary,
          applyUrl:    j.applyUrl,
          description: j.description,
          source:      j.source ?? 'jobspy',
        })));
      } catch (parseErr) {
        console.log(`JobSpy: failed to parse JSON — ${parseErr}`);
        console.log(`JobSpy: raw stdout (first 500): ${stdout.slice(0, 500)}`);
        resolvePromise([]);
      }
    });

    proc.on('error', (err) => {
      console.log(`JobSpy: process error — ${err.message}`);
      resolvePromise([]);
    });
  });
}
