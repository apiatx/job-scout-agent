export interface ScrapedJob {
  title: string;
  company: string;
  location: string;
  salary?: string;
  applyUrl: string;
  description?: string;
  source: string;
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

interface WorkdayJobPosting {
  title?: string;
  locationsText?: string;
  externalPath?: string;
}

interface WorkdayResponse {
  jobPostings?: WorkdayJobPosting[];
}

export async function scrapeGreenhouseJobs(slug: string, companyName: string): Promise<ScrapedJob[]> {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    console.log(`Greenhouse: scanning ${slug}...`);
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
      source: 'Greenhouse',
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
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
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
      source: 'Lever',
    }));
  } catch (e) {
    console.log(`Lever error for ${slug}:`, e);
    return [];
  }
}

export async function scrapeWorkdayJobs(
  companySlug: string,
  workdayDomain: string,
  companyName: string,
  careerSite?: string
): Promise<ScrapedJob[]> {
  const site = careerSite ?? `${companySlug}_Careers`;
  const domainVariants = [workdayDomain];
  const wdMatch = workdayDomain.match(/^(.+)\.(wd\d+)\.myworkdayjobs\.com$/);
  if (wdMatch) {
    const [, prefix] = wdMatch;
    for (const n of ['wd1', 'wd3', 'wd5']) {
      const variant = `${prefix}.${n}.myworkdayjobs.com`;
      if (variant !== workdayDomain) domainVariants.push(variant);
    }
  }

  for (const domain of domainVariants) {
    try {
      const url = `https://${domain}/wday/cxs/${companySlug}/${site}/jobs`;
      console.log(`Workday: scanning ${domain} (${site})...`);
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(8000),
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
        body: JSON.stringify({ limit: 20, offset: 0, searchText: 'account executive' }),
      });
      if (!response.ok) {
        console.log(`Workday: ${domain} returned ${response.status}, trying next...`);
        continue;
      }
      const data = (await response.json()) as WorkdayResponse;
      const postings = data.jobPostings ?? [];
      console.log(`Workday: found ${postings.length} jobs at ${domain}`);
      return postings
        .filter((p) => p.title && p.externalPath)
        .map((p) => ({
          title: p.title!,
          company: companyName,
          location: p.locationsText ?? 'Unknown',
          applyUrl: `https://${domain}/${companySlug}/${site}/job${p.externalPath}`,
          source: 'Workday',
        }));
    } catch (e) {
      console.log(`Workday error for ${domain}:`, e);
    }
  }
  console.log(`Workday: all variants failed for ${companySlug}`);
  return [];
}

export async function scrapePlainWebsite(url: string, companyName: string): Promise<ScrapedJob[]> {
  try {
    console.log(`Plain: scanning ${url}...`);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });
    if (!response.ok) {
      console.log(`Plain: couldn't fetch ${url} (status ${response.status})`);
      return [];
    }
    const html = await response.text();
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 8000);
    console.log(`Plain: fetched ${url} (${text.length} chars)`);
    return [{ title: `Jobs at ${companyName} (page scan)`, company: companyName, location: 'See listing', applyUrl: url, description: text, source: 'Web' }];
  } catch (e) {
    console.log(`Plain error for ${url}:`, e);
    return [];
  }
}
