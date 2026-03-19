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

interface AdzunaJob {
  id: string;
  title: string;
  description: string;
  redirect_url: string;
  company: { display_name: string };
  location: { display_name: string; area?: string[] };
  salary_min?: number;
  salary_max?: number;
}

interface AdzunaResponse {
  results: AdzunaJob[];
  count: number;
}

export async function scrapeGreenhouseJobs(slug: string, companyName: string): Promise<ScrapedJob[]> {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    console.log(`Greenhouse: scanning ${slug}...`);
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
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
    console.log(`Greenhouse error for ${slug}:`, e);
    return [];
  }
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

// Adzuna job search API — replaces broken Workday and plain website scrapers
export async function searchAdzunaJobs(query: string, locationFilter?: string): Promise<ScrapedJob[]> {
  const appId = process.env.ADZUNA_APP_ID;
  const appKey = process.env.ADZUNA_APP_KEY;
  if (!appId || !appKey) {
    console.log(`Adzuna: skipping "${query}" — ADZUNA_APP_ID or ADZUNA_APP_KEY not set`);
    return [];
  }
  try {
    const params = new URLSearchParams({
      app_id: appId,
      app_key: appKey,
      results_per_page: '50',
      what: query,
      'content-type': 'application/json',
    });
    if (locationFilter) {
      params.set('where', locationFilter);
    }
    const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?${params.toString()}`;
    console.log(`Adzuna: searching "${query}"${locationFilter ? ` near "${locationFilter}"` : ''}...`);
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      console.log(`Adzuna: search failed for "${query}" (status ${response.status})`);
      return [];
    }
    const data = (await response.json()) as AdzunaResponse;
    console.log(`Adzuna: found ${data.results?.length ?? 0} results for "${query}"`);
    if (!data.results) return [];
    return data.results.map((job) => {
      let salary: string | undefined;
      if (job.salary_min && job.salary_max) {
        salary = `$${Math.round(job.salary_min).toLocaleString()} - $${Math.round(job.salary_max).toLocaleString()}`;
      } else if (job.salary_min) {
        salary = `$${Math.round(job.salary_min).toLocaleString()}+`;
      }
      return {
        title: job.title,
        company: job.company.display_name,
        location: job.location.display_name,
        salary,
        applyUrl: job.redirect_url,
        description: job.description?.slice(0, 2000),
      };
    });
  } catch (e) {
    console.log(`Adzuna error for "${query}":`, e);
    return [];
  }
}

// Search queries targeting enterprise hardware/infrastructure sales roles
export const ADZUNA_SEARCH_QUERIES = [
  'Enterprise Account Executive semiconductor',
  'Enterprise Account Executive data center',
  'Enterprise Account Executive networking hardware',
  'Enterprise Account Executive storage',
  'Enterprise Account Executive AI infrastructure',
  'Strategic Account Executive hardware',
  'Account Executive GPU compute',
  'Account Executive industrial automation',
  'Account Executive energy technology',
  'Sales Director semiconductor',
  'Regional Sales Manager data center',
];
