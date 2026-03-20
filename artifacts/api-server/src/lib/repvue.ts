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
  console.warn('Playwright not available — RepVue integration disabled. Run: npx playwright install chromium');
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
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(15000);

    // Navigate to RepVue and log in
    await page.goto('https://www.repvue.com/login');
    await page.fill('input[name="email"], input[type="email"]', email);
    await page.fill('input[name="password"], input[type="password"]', password);
    await page.click('button[type="submit"]');

    // Wait for login to complete
    await page.waitForURL('**/dashboard**', { timeout: 15000 }).catch(() => {
      // Some accounts redirect elsewhere; just wait for navigation
      return page.waitForLoadState('networkidle', { timeout: 10000 });
    });

    // Search for the company
    await page.goto(`https://www.repvue.com/search?q=${encodeURIComponent(companyName)}`);
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Click the first matching company result
    const firstResult = page.locator('a[href*="/companies/"], a[href*="/org/"]').first();
    const resultExists = await firstResult.isVisible().catch(() => false);
    if (!resultExists) {
      console.log(`RepVue: company "${companyName}" not found in search results`);
      return null;
    }
    await firstResult.click();
    await page.waitForLoadState('networkidle', { timeout: 10000 });

    // Scrape data from the company page
    const getText = async (sel: string) => {
      try {
        const el = page.locator(sel).first();
        const visible = await el.isVisible().catch(() => false);
        return visible ? (await el.textContent())?.trim() || null : null;
      } catch { return null; }
    };

    const getNum = async (sel: string): Promise<number | null> => {
      const text = await getText(sel);
      if (!text) return null;
      const num = parseFloat(text.replace(/[^0-9.]/g, ''));
      return isNaN(num) ? null : num;
    };

    // Try common selectors for RepVue company pages
    const repVueScore = await getNum('[data-testid="overall-score"], .overall-score, .score-value');
    const quotaAttainment = await getNum('[data-testid="quota-attainment"], .quota-attainment');
    const percentHittingQuota = await getNum('[data-testid="percent-hitting-quota"], .percent-hitting');
    const baseSalaryRange = await getText('[data-testid="base-salary"], .base-salary');
    const oteSalaryRange = await getText('[data-testid="ote-salary"], .ote-salary');
    const cultureRating = await getNum('[data-testid="culture-rating"], .culture-rating');
    const productRating = await getNum('[data-testid="product-rating"], .product-rating');
    const inboundLeadFlow = await getText('[data-testid="inbound-leads"], .inbound-leads');

    // Scrape top 3 reviews
    const reviews: string[] = [];
    const reviewEls = page.locator('.review-text, .review-content, [data-testid="review"]');
    const reviewCount = Math.min(await reviewEls.count(), 3);
    for (let i = 0; i < reviewCount; i++) {
      const text = await reviewEls.nth(i).textContent();
      if (text?.trim()) reviews.push(text.trim());
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
