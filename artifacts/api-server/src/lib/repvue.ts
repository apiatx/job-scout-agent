// ── RepVue Integration ───────────────────────────────────────────────────
// To use RepVue data, add these to your Replit Secrets:
//   REPVUE_EMAIL    — your RepVue account email
//   REPVUE_PASSWORD — your RepVue account password

export interface RepVueData {
  companyName: string;
  repVueScore: number | null;
  quotaAttainment: number | null;
  percentHittingQuota: number | null;
  baseSalaryRange: string | null;
  oteSalaryRange: string | null;
  cultureRating: number | null;
  productRating: number | null;
  inboundLeadFlow: string | null;
  reviews: string[];
  scrapedAt: string;
}

// ── Sequential queue ────────────────────────────────────────────────────
// Only ONE request to RepVue at a time, with a delay between each.
const DELAY_BETWEEN_REQUESTS_MS = 3000;
const MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 5000;

const cache = new Map<string, RepVueData | null>();

// The queue: a chain of promises. Each new request appends to the end.
let queueTail: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    queueTail = queueTail.then(async () => {
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        reject(err);
      }
      // Wait before allowing the next queued request
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_REQUESTS_MS));
    });
  });
}

// ── Slug helpers ────────────────────────────────────────────────────────
function toRepVueSlug(name: string): string {
  return name
    .replace(/\s*\|.*$/, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/,?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company|Co\.?)$/i, '')
    .trim()
    .replace(/\s+/g, '');
}

function toKebabSlug(name: string): string {
  return name
    .replace(/\s*\|.*$/, '')
    .replace(/\s*\(.*?\)\s*/g, '')
    .replace(/,?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company|Co\.?)$/i, '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Fetch a single URL with retry on 429. NOT queued — called from within the queue.
 */
async function fetchOne(url: string): Promise<Response | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: 'follow' });
      if (res.status === 429) {
        const delay = RETRY_BASE_DELAY_MS * (attempt + 1);
        console.log(`RepVue [fetch]: 429 for ${url}, retrying in ${delay / 1000}s (${attempt + 1}/${MAX_RETRIES + 1})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      console.log(`RepVue [fetch]: ${url} → ${res.status}`);
      return res;
    } catch (err) {
      console.error(`RepVue [fetch]: network error for ${url}:`, err);
      return null;
    }
  }
  console.log(`RepVue [fetch]: giving up on ${url} after ${MAX_RETRIES + 1} attempts`);
  return null;
}

/**
 * Fetch RepVue data for a company. Runs inside the queue (one at a time).
 */
async function fetchRepVueData(companyName: string): Promise<RepVueData | null> {
  const slug = toRepVueSlug(companyName);
  const url = `https://www.repvue.com/companies/${slug}`;
  console.log(`RepVue [queue]: fetching "${companyName}" → ${url}`);

  const res = await fetchOne(url);
  if (res && res.ok) {
    return parseRepVueHtml(await res.text(), companyName);
  }

  // Try kebab-case slug if different
  const kebab = toKebabSlug(companyName);
  if (kebab !== slug.toLowerCase()) {
    const altUrl = `https://www.repvue.com/companies/${kebab}`;
    console.log(`RepVue [queue]: trying alternate slug → ${altUrl}`);
    const altRes = await fetchOne(altUrl);
    if (altRes && altRes.ok) {
      return parseRepVueHtml(await altRes.text(), companyName);
    }
  }

  return null;
}

/**
 * Parse RepVue company page HTML for embedded data.
 */
function parseRepVueHtml(html: string, companyName: string): RepVueData | null {
  let repVueScore: number | null = null;
  let quotaAttainment: number | null = null;
  let percentHittingQuota: number | null = null;
  let cultureRating: number | null = null;
  let productRating: number | null = null;
  let baseSalaryRange: string | null = null;
  let oteSalaryRange: string | null = null;
  let inboundLeadFlow: string | null = null;

  // Strategy 1: Parse __NEXT_DATA__ JSON
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const props = nextData?.props?.pageProps;
      if (props) {
        console.log(`RepVue [parse]: __NEXT_DATA__ keys: ${Object.keys(props).join(', ')}`);
        const findData = (obj: any): void => {
          if (!obj || typeof obj !== 'object') return;
          for (const [key, val] of Object.entries(obj)) {
            const k = key.toLowerCase();
            if (typeof val === 'number') {
              if ((k.includes('repvuescore') || k.includes('repvue_score') || k === 'score' || k === 'overallscore' || k === 'overall_score') && repVueScore === null && val > 0 && val <= 100)
                repVueScore = val;
              if ((k.includes('quotaattainment') || k.includes('quota_attainment')) && quotaAttainment === null)
                quotaAttainment = val;
              if ((k.includes('percenthitting') || k.includes('percent_hitting') || k.includes('hittingquota') || k.includes('hitting_quota')) && percentHittingQuota === null)
                percentHittingQuota = val;
              if (k.includes('culture') && cultureRating === null && val > 0 && val <= 5)
                cultureRating = val;
              if (k.includes('product') && (k.includes('rating') || k.includes('market') || k.includes('fit')) && productRating === null && val > 0 && val <= 5)
                productRating = val;
            }
            if (typeof val === 'string') {
              if (k.includes('basesalary') || k.includes('base_salary')) baseSalaryRange = val;
              if (k.includes('otesalary') || k.includes('ote_salary') || k === 'ote') oteSalaryRange = val;
              if (k.includes('inbound') && k.includes('lead')) inboundLeadFlow = val;
            }
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) findData(val);
          }
        };
        findData(props);
      }
    } catch (e) {
      console.log(`RepVue [parse]: failed to parse __NEXT_DATA__: ${e}`);
    }
  }

  // Strategy 2: Regex on raw HTML text
  if (repVueScore === null) {
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const scoreMatch = text.match(/RepVue\s*Score[:\s]*(\d+(?:\.\d+)?)/i)
      || text.match(/Overall\s*Score[:\s]*(\d+(?:\.\d+)?)/i);
    if (scoreMatch) repVueScore = parseFloat(scoreMatch[1]);

    const quotaMatch = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+reps?\s+)?(?:hitting|meeting|attaining)\s+quota/i)
      || text.match(/Quota\s*Attainment[:\s]*(\d+(?:\.\d+)?)/i);
    if (quotaMatch) percentHittingQuota = parseFloat(quotaMatch[1]);

    const cultureMatch = text.match(/Culture[^:]*?[:\s]*(\d+(?:\.\d+)?)\s*(?:\/\s*5|out of 5)/i);
    if (cultureMatch) cultureRating = parseFloat(cultureMatch[1]);

    const productMatch = text.match(/Product[\s-]*Market\s*Fit[^:]*?[:\s]*(\d+(?:\.\d+)?)\s*(?:\/\s*5|out of 5)/i);
    if (productMatch) productRating = parseFloat(productMatch[1]);

    console.log(`RepVue [parse]: text preview: ${text.substring(0, 500)}`);
  }

  if (repVueScore === null) {
    console.log(`RepVue [parse]: could not extract score for "${companyName}"`);
    return null;
  }

  console.log(`RepVue [parse]: score=${repVueScore} for "${companyName}"`);
  return {
    companyName, repVueScore, quotaAttainment, percentHittingQuota,
    baseSalaryRange, oteSalaryRange, cultureRating, productRating,
    inboundLeadFlow, reviews: [], scrapedAt: new Date().toISOString(),
  };
}

// ── Public entry point ──────────────────────────────────────────────────
// Deduplicates + caches + queues one-at-a-time with delays.
const pending = new Map<string, Promise<RepVueData | null>>();

export async function scrapeRepVue(companyName: string): Promise<RepVueData | null> {
  const key = companyName.toLowerCase().trim();

  // Return cached result instantly
  if (cache.has(key)) {
    return cache.get(key) ?? null;
  }

  // Deduplicate: if already queued/in-flight, return the same promise
  if (pending.has(key)) {
    return pending.get(key)!;
  }

  // Queue this request — it will wait its turn
  const promise = enqueue(() => fetchRepVueData(companyName)).then(result => {
    cache.set(key, result);
    pending.delete(key);
    return result;
  });

  pending.set(key, promise);
  return promise;
}
