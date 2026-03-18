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
  updated_at?: string;
}

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  categories?: { location?: string; team?: string };
  descriptionPlain?: string;
}

export async function scrapeGreenhouseJobs(slug: string): Promise<ScrapedJob[]> {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return [];
    const data = (await response.json()) as { jobs?: GreenhouseJob[] };
    if (!data.jobs) return [];
    return data.jobs.map((job: GreenhouseJob) => ({
      title: job.title,
      company: slug,
      location: job.location?.name || "Unknown",
      applyUrl: job.absolute_url,
    }));
  } catch {
    return [];
  }
}

export async function scrapeLeverJobs(slug: string): Promise<ScrapedJob[]> {
  try {
    const url = `https://api.lever.co/v0/postings/${slug}?mode=json`;
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return [];
    const data = (await response.json()) as LeverJob[];
    return data.map((job: LeverJob) => ({
      title: job.text,
      company: slug,
      location: job.categories?.location || "Unknown",
      applyUrl: job.hostedUrl,
      description: job.descriptionPlain?.slice(0, 2000),
    }));
  } catch {
    return [];
  }
}
