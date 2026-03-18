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
  categories?: { location?: string; team?: string };
  descriptionPlain?: string;
}

export async function scrapeGreenhouseJobs(slug: string, companyName: string): Promise<ScrapedJob[]> {
  try {
    const url = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`;
    console.log(`Greenhouse: scanning ${slug}...`);
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      console.log(`Greenhouse: couldn't find company '${slug}' (status ${response.status})`);
      return [];
    }
    const data = (await response.json()) as { jobs?: GreenhouseJob[] };
    if (!data.jobs) return [];
    console.log(`Greenhouse: found ${data.jobs.length} jobs at ${slug}`);
    return data.jobs.map((job: GreenhouseJob) => ({
      title: job.title,
      company: companyName,
      location: job.location?.name || "Unknown",
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
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      console.log(`Lever: couldn't find company '${slug}' (status ${response.status})`);
      return [];
    }
    const data = (await response.json()) as LeverJob[];
    console.log(`Lever: found ${data.length} jobs at ${slug}`);
    return data.map((job: LeverJob) => ({
      title: job.text,
      company: companyName,
      location: job.categories?.location || "Unknown",
      applyUrl: job.hostedUrl,
      description: job.descriptionPlain?.slice(0, 2000),
    }));
  } catch (e) {
    console.log(`Lever error for ${slug}:`, e);
    return [];
  }
}

export async function scrapePlainWebsite(url: string, companyName: string): Promise<ScrapedJob[]> {
  try {
    console.log(`Plain: scanning ${url}...`);
    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
    });
    if (!response.ok) {
      console.log(`Plain: couldn't fetch ${url} (status ${response.status})`);
      return [];
    }
    const html = await response.text();
    // Strip HTML tags to get readable text, limit to 8000 chars
    const text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 8000);

    console.log(`Plain: fetched ${url} (${text.length} chars)`);

    // Return as a single "page" item — Claude will extract individual jobs from the text
    return [
      {
        title: `Jobs at ${companyName} (page scan)`,
        company: companyName,
        location: "See listing",
        applyUrl: url,
        description: text,
      },
    ];
  } catch (e) {
    console.log(`Plain error for ${url}:`, e);
    return [];
  }
}
