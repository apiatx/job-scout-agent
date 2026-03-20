// ── RepVue Integration ───────────────────────────────────────────────────
// To use RepVue data, add these to your Replit Secrets:
//   REPVUE_EMAIL    — your RepVue account email
//   REPVUE_PASSWORD — your RepVue account password

// Dynamic import to avoid crash if playwright browsers aren't installed
let chromium: typeof import('playwright')['chromium'] | null = null;
try {
  const pw = await import('playwright');
  chromium = pw.chromium;
} catch {
  // Playwright not installed — RepVue features silently disabled
}
type Browser = import('playwright').Browser;

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
 * Strips suffixes like "Inc", "Inc.", "LLC", parenthesised text, pipes, etc.
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

export async function scrapeRepVue(companyName: string): Promise<RepVueData | null> {
  if (!chromium) {
    return null;
  }
  const email = process.env.REPVUE_EMAIL;
  const password = process.env.REPVUE_PASSWORD;
  if (!email || !password) {
    console.log('RepVue credentials not configured — skipping');
    return null;
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    // ── Step 1: Log in ────────────────────────────────────────────────
    await page.goto('https://www.repvue.com/login', { waitUntil: 'networkidle' });
    await page.fill('input[name="email"], input[type="email"]', email);
    await page.fill('input[name="password"], input[type="password"]', password);
    await page.click('button[type="submit"]');

    // Wait for navigation away from the login page
    await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15000 }).catch(() => {
      return page.waitForLoadState('networkidle', { timeout: 10000 });
    });
    console.log(`RepVue: logged in, now at ${page.url()}`);

    // ── Step 2: Navigate directly to company page ─────────────────────
    const slug = toRepVueSlug(companyName);
    const companyUrl = `https://www.repvue.com/companies/${slug}`;
    console.log(`RepVue: navigating to ${companyUrl}`);
    const response = await page.goto(companyUrl, { waitUntil: 'networkidle' });

    // Check if the page loaded (not a 404 or redirect to search)
    const finalUrl = page.url();
    const status = response?.status() ?? 0;
    console.log(`RepVue: landed on ${finalUrl} (status ${status})`);

    if (status === 404 || finalUrl.includes('/search') || finalUrl.includes('/404')) {
      // Direct slug didn't work — try searching instead
      console.log(`RepVue: slug "${slug}" not found, trying search fallback`);
      await page.goto(`https://www.repvue.com/companies?q=${encodeURIComponent(companyName)}`, { waitUntil: 'networkidle' });
      // Look for the first company link in results
      const firstLink = page.locator('a[href*="/companies/"]').first();
      const linkVisible = await firstLink.isVisible().catch(() => false);
      if (!linkVisible) {
        console.log(`RepVue: company "${companyName}" not found via search either`);
        return null;
      }
      await firstLink.click();
      await page.waitForLoadState('networkidle', { timeout: 10000 });
      console.log(`RepVue: search redirected to ${page.url()}`);
    }

    // ── Step 3: Extract data from the page ────────────────────────────
    // Wait a moment for any client-side rendering
    await page.waitForTimeout(2000);

    // Try to find __NEXT_DATA__ (Next.js pages embed data as JSON)
    const nextData = await page.evaluate(() => {
      const el = document.getElementById('__NEXT_DATA__');
      if (el?.textContent) {
        try { return JSON.parse(el.textContent); } catch { return null; }
      }
      return null;
    });

    let repVueScore: number | null = null;
    let quotaAttainment: number | null = null;
    let percentHittingQuota: number | null = null;
    let cultureRating: number | null = null;
    let productRating: number | null = null;
    let baseSalaryRange: string | null = null;
    let oteSalaryRange: string | null = null;
    let inboundLeadFlow: string | null = null;
    const reviews: string[] = [];

    if (nextData?.props?.pageProps) {
      // Extract from Next.js page data
      const props = nextData.props.pageProps;
      console.log(`RepVue: found __NEXT_DATA__, pageProps keys: ${Object.keys(props).join(', ')}`);

      // Try common data shapes — the exact key depends on the site
      const org = props.organization || props.company || props.org || props;
      if (org) {
        repVueScore = org.repvueScore ?? org.repVueScore ?? org.overall_score ?? org.score ?? null;
        quotaAttainment = org.quotaAttainment ?? org.quota_attainment ?? null;
        percentHittingQuota = org.percentHittingQuota ?? org.percent_hitting_quota ?? null;
        cultureRating = org.cultureRating ?? org.culture_rating ?? org.culture ?? null;
        productRating = org.productRating ?? org.product_rating ?? org.productMarketFit ?? null;
        baseSalaryRange = org.baseSalary ?? org.base_salary ?? null;
        oteSalaryRange = org.oteSalary ?? org.ote_salary ?? org.ote ?? null;
        inboundLeadFlow = org.inboundLeadFlow ?? org.inbound_lead_flow ?? null;
      }
    }

    // Fallback: extract from visible page text
    if (repVueScore === null) {
      console.log('RepVue: __NEXT_DATA__ extraction missed score, trying page text...');
      const pageText = await page.evaluate(() => document.body.innerText);

      // Look for RepVue Score pattern (usually a prominent number like "85.89")
      const scoreMatch = pageText.match(/RepVue\s*Score[:\s]*(\d+(?:\.\d+)?)/i)
        || pageText.match(/Overall\s*Score[:\s]*(\d+(?:\.\d+)?)/i);
      if (scoreMatch) repVueScore = parseFloat(scoreMatch[1]);

      // Quota attainment
      const quotaMatch = pageText.match(/(\d+(?:\.\d+)?)\s*%\s*(?:of\s+reps?\s+)?(?:hitting|meeting|attaining)\s+quota/i)
        || pageText.match(/Quota\s*Attainment[:\s]*(\d+(?:\.\d+)?)/i);
      if (quotaMatch) percentHittingQuota = parseFloat(quotaMatch[1]);

      // Culture rating (out of 5)
      const cultureMatch = pageText.match(/Culture[^:]*?[:\s]*(\d+(?:\.\d+)?)\s*(?:\/\s*5|out of 5)/i);
      if (cultureMatch) cultureRating = parseFloat(cultureMatch[1]);

      // Product-Market Fit
      const productMatch = pageText.match(/Product[\s-]*Market\s*Fit[^:]*?[:\s]*(\d+(?:\.\d+)?)\s*(?:\/\s*5|out of 5)/i);
      if (productMatch) productRating = parseFloat(productMatch[1]);

      // Log a snippet of the page text for debugging
      console.log(`RepVue: page text preview (first 500 chars): ${pageText.substring(0, 500).replace(/\n/g, ' | ')}`);
    }

    // If we still have no score, this company page didn't load properly
    if (repVueScore === null) {
      console.log(`RepVue: could not extract score for "${companyName}" — page may require different selectors`);
      // Return partial data if we have anything
    }

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
      reviews,
      scrapedAt: new Date().toISOString(),
    };
  } catch (e) {
    console.error(`RepVue scrape error for "${companyName}":`, e);
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
