import { execFile } from 'child_process';
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

// JobSpy scraper — calls Python script that searches LinkedIn, Indeed, and Glassdoor
export async function runJobSpyScraper(): Promise<ScrapedJob[]> {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const scriptPath = resolve(scriptDir, 'jobspy_scraper.py');

  console.log(`\n──── JOBSPY SEARCH ────────────────────────────────────────`);
  console.log(`Running JobSpy Python scraper (LinkedIn + Indeed + Glassdoor)...`);

  return new Promise((resolvePromise) => {
    const proc = execFile(
      'python3',
      [scriptPath],
      { maxBuffer: 50 * 1024 * 1024, timeout: 600_000 },
      (error, stdout, stderr) => {
        // Log stderr (progress messages) line by line
        if (stderr) {
          for (const line of stderr.split('\n')) {
            if (line.trim()) console.log(`  ${line}`);
          }
        }

        if (error) {
          console.log(`JobSpy: script error — ${error.message}`);
          resolvePromise([]);
          return;
        }

        try {
          const jobs = JSON.parse(stdout) as Array<{
            title: string;
            company: string;
            location: string;
            salary?: string;
            applyUrl: string;
            description?: string;
            source: string;
          }>;
          console.log(`JobSpy: received ${jobs.length} jobs from Python script`);
          console.log(`───────────────────────────────────────────────────────────`);
          return resolvePromise(
            jobs.map((j) => ({
              title: j.title,
              company: j.company,
              location: j.location,
              salary: j.salary,
              applyUrl: j.applyUrl,
              description: j.description,
            }))
          );
        } catch (parseErr) {
          console.log(`JobSpy: failed to parse output — ${parseErr}`);
          console.log(`JobSpy: raw stdout (first 500 chars): ${stdout?.slice(0, 500)}`);
          resolvePromise([]);
        }
      }
    );

    // Forward stderr in real time
    proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.trim()) console.log(`  [JobSpy] ${line}`);
      }
    });
  });
}
