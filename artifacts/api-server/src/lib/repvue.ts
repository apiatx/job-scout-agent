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

/**
 * Convert a company display name into the RepVue URL slug.
 * "Pure Storage" → "PureStorage", "Hewlett Packard Enterprise" → "HewlettPackardEnterprise"
 */
function toRepVueSlug(name: string): string {
  let cleaned = name
    .replace(/\s*\|.*$/, '')            // strip pipe-suffix ("HPE | Aruba" → "HPE")
    .replace(/\s*\(.*?\)\s*/g, '')      // strip parenthesised text
    .replace(/,?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company|Co\.?)$/i, '')
    .trim();
  // Remove spaces — RepVue slugs are PascalCase without separators
  return cleaned.replace(/\s+/g, '');
}

// Common headers to avoid bot detection
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
 * Try to extract RepVue data using plain HTTP fetch (no browser required).
 * Works by fetching the company page HTML and parsing __NEXT_DATA__ or text.
 */
async function fetchRepVueData(companyName: string): Promise<RepVueData | null> {
  const slug = toRepVueSlug(companyName);
  const url = `https://www.repvue.com/companies/${slug}`;
  console.log(`RepVue [fetch]: trying ${url}`);

  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: 'follow',
    });

    console.log(`RepVue [fetch]: ${url} → ${res.status}`);

    if (!res.ok) {
      // Try alternate slug formats for multi-word names
      // e.g., "hewlett-packard-enterprise" or lowercase
      const altSlug = companyName
        .replace(/\s*\|.*$/, '')
        .replace(/\s*\(.*?\)\s*/g, '')
        .replace(/,?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company|Co\.?)$/i, '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

      if (altSlug !== slug.toLowerCase()) {
        const altUrl = `https://www.repvue.com/companies/${altSlug}`;
        console.log(`RepVue [fetch]: trying alternate slug: ${altUrl}`);
        const altRes = await fetch(altUrl, { headers: BROWSER_HEADERS, redirect: 'follow' });
        console.log(`RepVue [fetch]: ${altUrl} → ${altRes.status}`);
        if (!altRes.ok) return null;
        return parseRepVueHtml(await altRes.text(), companyName);
      }
      return null;
    }

    return parseRepVueHtml(await res.text(), companyName);
  } catch (err) {
    console.error(`RepVue [fetch] error for "${companyName}":`, err);
    return null;
  }
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

  // ── Strategy 1: Parse __NEXT_DATA__ JSON ──────────────────────────
  const nextDataMatch = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      const props = nextData?.props?.pageProps;
      if (props) {
        console.log(`RepVue [parse]: __NEXT_DATA__ pageProps keys: ${Object.keys(props).join(', ')}`);

        // Walk through props looking for score-like fields
        const findData = (obj: any): void => {
          if (!obj || typeof obj !== 'object') return;
          for (const [key, val] of Object.entries(obj)) {
            const k = key.toLowerCase();
            if (typeof val === 'number') {
              if (k.includes('repvuescore') || k.includes('repvue_score') || k === 'score' || k === 'overallscore' || k === 'overall_score') {
                if (repVueScore === null && val > 0 && val <= 100) repVueScore = val;
              }
              if (k.includes('quotaattainment') || k.includes('quota_attainment')) {
                if (quotaAttainment === null) quotaAttainment = val;
              }
              if (k.includes('percenthitting') || k.includes('percent_hitting') || k.includes('hittingquota') || k.includes('hitting_quota')) {
                if (percentHittingQuota === null) percentHittingQuota = val;
              }
              if (k.includes('culture')) {
                if (cultureRating === null && val > 0 && val <= 5) cultureRating = val;
              }
              if (k.includes('product') && (k.includes('rating') || k.includes('market') || k.includes('fit'))) {
                if (productRating === null && val > 0 && val <= 5) productRating = val;
              }
            }
            if (typeof val === 'string') {
              if (k.includes('basesalary') || k.includes('base_salary')) baseSalaryRange = val;
              if (k.includes('otesalary') || k.includes('ote_salary') || k === 'ote') oteSalaryRange = val;
              if (k.includes('inbound') && k.includes('lead')) inboundLeadFlow = val;
            }
            // Recurse into nested objects (but not too deep)
            if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
              findData(val);
            }
          }
        };
        findData(props);
      }
    } catch (e) {
      console.log(`RepVue [parse]: failed to parse __NEXT_DATA__: ${e}`);
    }
  } else {
    console.log('RepVue [parse]: no __NEXT_DATA__ found in HTML');
  }

  // ── Strategy 2: Regex on raw HTML text ────────────────────────────
  if (repVueScore === null) {
    // Strip HTML tags for text analysis
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

    // Log a snippet for debugging
    const preview = text.substring(0, 800);
    console.log(`RepVue [parse]: text preview: ${preview}`);
  }

  if (repVueScore === null) {
    console.log(`RepVue [parse]: could not extract score for "${companyName}"`);
    return null;
  }

  console.log(`RepVue [parse]: extracted score ${repVueScore} for "${companyName}"`);

  return {
    companyName,
    repVueScore,
    quotaAttainment,
    percentHittingQuota,
    baseSalaryRange,
    oteSalaryRange,
    cultureRating,
    productRating,
    inboundLeadFlow,
    reviews: [],
    scrapedAt: new Date().toISOString(),
  };
}

// ── Playwright fallback (only if fetch approach fails) ──────────────────
let chromium: typeof import('playwright')['chromium'] | null = null;
try {
  const pw = await import('playwright');
  chromium = pw.chromium;
  // Verify browsers are actually installed
  const browser = await chromium.launch({ headless: true });
  await browser.close();
  console.log('RepVue: Playwright browsers available');
} catch {
  chromium = null;
  console.log('RepVue: Playwright browsers NOT available — using fetch-only mode');
}
type Browser = import('playwright').Browser;

async function playwrightRepVue(companyName: string): Promise<RepVueData | null> {
  if (!chromium) return null;

  const email = process.env.REPVUE_EMAIL;
  const password = process.env.REPVUE_PASSWORD;
  if (!email || !password) return null;

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: BROWSER_HEADERS['User-Agent'] });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    // Log in
    await page.goto('https://www.repvue.com/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="email"], input[type="email"]', email);
    await page.fill('input[name="password"], input[type="password"]', password);
    await page.click('button[type="submit"]');
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 }).catch(() =>
      page.waitForLoadState('networkidle', { timeout: 10000 })
    );
    console.log(`RepVue [playwright]: logged in, at ${page.url()}`);

    // Go to company page
    const slug = toRepVueSlug(companyName);
    await page.goto(`https://www.repvue.com/companies/${slug}`, { waitUntil: 'networkidle' });
    console.log(`RepVue [playwright]: navigated to ${page.url()}`);

    await page.waitForTimeout(2000);
    const html = await page.content();
    return parseRepVueHtml(html, companyName);
  } catch (e) {
    console.error(`RepVue [playwright] error for "${companyName}":`, e);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ── Public entry point ──────────────────────────────────────────────────
export async function scrapeRepVue(companyName: string): Promise<RepVueData | null> {
  // Try fetch first (fast, no browser needed)
  const fetchResult = await fetchRepVueData(companyName);
  if (fetchResult) return fetchResult;

  // Fall back to Playwright if available
  console.log(`RepVue: fetch failed for "${companyName}", trying Playwright fallback...`);
  return playwrightRepVue(companyName);
}
