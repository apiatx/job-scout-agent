import Parser from 'rss-parser';
import { Pool } from 'pg';
// [Removed] Gemini import (GoogleGenAI)

const parser = new Parser({
  timeout: 8000,
  headers: { 'User-Agent': 'JobScout/1.0 (+https://jobscout.ai)' },
  customFields: { item: [['media:content', 'media'], ['content:encoded', 'contentEncoded']] }
});

const RSS_SOURCES: Array<{ name: string; url: string; sector: string }> = [
  { name: 'TechCrunch',      url: 'https://techcrunch.com/feed/',                                  sector: 'Startups & Funding' },
  { name: 'VentureBeat',     url: 'https://venturebeat.com/feed/',                                 sector: 'Enterprise AI' },
  { name: 'The Register',    url: 'https://www.theregister.com/headlines.atom',                    sector: 'Enterprise IT' },
  { name: 'Dark Reading',    url: 'https://www.darkreading.com/rss.xml',                           sector: 'Cybersecurity' },
  { name: 'SiliconANGLE',    url: 'https://siliconangle.com/feed/',                               sector: 'Enterprise Cloud' },
  { name: 'CRN',             url: 'https://www.crn.com/feeds/rss/all.xml',                        sector: 'Channel & Partners' },
  { name: 'SecurityWeek',    url: 'https://feeds.feedburner.com/securityweek',                    sector: 'Cybersecurity' },
  { name: 'Ars Technica',    url: 'https://feeds.arstechnica.com/arstechnica/technology-lab',     sector: 'Enterprise Tech' },
  { name: 'Wired Business',  url: 'https://www.wired.com/feed/category/business/latest/rss',      sector: 'Tech Business' },
  { name: 'ZDNet',           url: 'https://www.zdnet.com/news/rss.xml',                           sector: 'Enterprise IT' },
  { name: 'Hacker News',     url: 'https://hnrss.org/frontpage?count=30&points=50',               sector: 'Developer & Infra' },
];

const B2B_KEYWORDS = [
  'enterprise', 'b2b', 'saas', 'software', 'platform', 'cloud', 'api', 'cybersecurity', 'security',
  'funding', 'series', 'valuation', 'ipo', 'acquisition', 'merger', 'revenue', 'ARR', 'customers',
  'hardware', 'semiconductor', 'chip', 'data center', 'AI', 'machine learning', 'automation',
  'startup', 'vendor', 'partner', 'integration', 'infrastructure', 'analytics', 'fintech',
  'healthtech', 'logistics', 'supply chain', 'manufacturing', 'robotics', 'IoT', 'edge computing',
  'hiring', 'headcount', 'layoff', 'workforce', 'raise', 'invest', 'deploy', 'launch'
];

function isB2BRelevant(title: string, desc: string): boolean {
  const text = (title + ' ' + desc).toLowerCase();
  return B2B_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
}

export async function fetchRssArticles(maxPerSource = 15): Promise<Array<{
  url: string; title: string; source: string; sector: string;
  published: Date | null; description: string;
}>> {
  const results: Array<{ url: string; title: string; source: string; sector: string; published: Date | null; description: string }> = [];
  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000); // 48h window

  await Promise.allSettled(
    RSS_SOURCES.map(async src => {
      try {
        const feed = await parser.parseURL(src.url);
        let count = 0;
        for (const item of feed.items) {
          if (count >= maxPerSource) break;
          if (!item.link || !item.title) continue;
          const pub = item.pubDate ? new Date(item.pubDate) : null;
          if (pub && pub < cutoff) continue;
          const desc = item.contentSnippet || item.summary || item.content || '';
          if (!isB2BRelevant(item.title, desc)) continue;
          results.push({
            url: item.link,
            title: item.title.trim(),
            source: src.name,
            sector: src.sector,
            published: pub,
            description: desc.slice(0, 600),
          });
          count++;
        }
      } catch { /* source failed, skip */ }
    })
  );

  // Sort newest first, deduplicate by URL
  const seen = new Set<string>();
  return results
    .filter(a => { if (seen.has(a.url)) return false; seen.add(a.url); return true; })
    .sort((a, b) => (b.published?.getTime() ?? 0) - (a.published?.getTime() ?? 0));
}

const GEMINI_MODELS = [
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
  'gemini-flash-latest',
];

// [Removed] Gemini article analysis — returns empty array
export async function analyzeArticleBatch(
  _articles: Array<{ url: string; title: string; source: string; description: string }>,
  _geminiKey: string
): Promise<Array<{
  url: string;
  company_name: string;
  summary: string;
  why_it_matters: string;
  hiring_signal: string;
  sales_territory: string;
  funding_stage: string;
  employee_count_est: string;
  relevance_score: number;
  sector: string;
  tags: string[];
}>> {
  return [];
}

export async function refreshIndustryNews(pool: Pool, geminiKey: string): Promise<{
  inserted: number; analyzed: number; sources: number; model: string;
}> {
  console.log('[IndustryNews] Fetching RSS articles…');
  const articles = await fetchRssArticles(15);
  console.log(`[IndustryNews] Fetched ${articles.length} B2B-relevant articles from RSS`);

  // Filter out already-analyzed articles
  const existingRes = await pool.query<{ article_url: string }>(
    'SELECT article_url FROM industry_news WHERE analyzed_at > NOW() - INTERVAL \'72 hours\''
  );
  const existingUrls = new Set(existingRes.rows.map(r => r.article_url));
  const newArticles = articles.filter(a => !existingUrls.has(a.url));
  console.log(`[IndustryNews] ${newArticles.length} new articles to analyze`);

  if (!newArticles.length) {
    return { inserted: 0, analyzed: 0, sources: 0, model: 'gemini-3-flash-preview' };
  }

  // Analyze in batches of 6
  const BATCH = 6;
  let inserted = 0;
  const uniqueSources = new Set<string>();

  for (let i = 0; i < Math.min(newArticles.length, 48); i += BATCH) {
    const batch = newArticles.slice(i, i + BATCH);
    batch.forEach(a => uniqueSources.add(a.source));
    try {
      const analyzed = await analyzeArticleBatch(batch, geminiKey);
      for (const result of analyzed) {
        const orig = batch.find(a => a.url === result.url);
        if (!orig) continue;
        try {
          await pool.query(`
            INSERT INTO industry_news
              (article_url, title, source_name, published_at, company_name, summary,
               why_it_matters, hiring_signal, sales_territory, funding_stage,
               employee_count_est, relevance_score, sector, tags, raw_description, analyzed_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
            ON CONFLICT (article_url) DO UPDATE SET
              company_name = EXCLUDED.company_name,
              summary = EXCLUDED.summary,
              why_it_matters = EXCLUDED.why_it_matters,
              hiring_signal = EXCLUDED.hiring_signal,
              sales_territory = EXCLUDED.sales_territory,
              funding_stage = EXCLUDED.funding_stage,
              employee_count_est = EXCLUDED.employee_count_est,
              relevance_score = EXCLUDED.relevance_score,
              sector = EXCLUDED.sector,
              tags = EXCLUDED.tags,
              analyzed_at = NOW()
          `, [
            orig.url, orig.title, orig.source, orig.published,
            result.company_name, result.summary, result.why_it_matters,
            result.hiring_signal, result.sales_territory, result.funding_stage,
            result.employee_count_est, result.relevance_score, result.sector,
            result.tags, orig.description
          ]);
          inserted++;
        } catch { /* skip individual insert errors */ }
      }
    } catch (err) {
      console.error('[IndustryNews] Batch analysis error:', err);
    }
  }

  const model = 'gemini-3-flash-preview';
  await pool.query(
    `INSERT INTO industry_news_meta (id, article_count, model_used, sources_fetched, generated_at)
     VALUES (1,$1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE SET article_count = EXCLUDED.article_count,
       model_used = EXCLUDED.model_used, sources_fetched = EXCLUDED.sources_fetched,
       generated_at = NOW()`,
    [inserted, model, uniqueSources.size]
  );

  console.log(`[IndustryNews] Done — ${inserted} articles inserted/updated`);
  return { inserted, analyzed: newArticles.length, sources: uniqueSources.size, model };
}

export async function getLatestNews(pool: Pool, limit = 60): Promise<{
  articles: any[]; meta: any;
}> {
  const [articlesRes, metaRes] = await Promise.all([
    pool.query(`
      SELECT id, article_url, title, source_name, published_at, company_name, summary,
             why_it_matters, hiring_signal, sales_territory, funding_stage,
             employee_count_est, relevance_score, sector, tags, analyzed_at
      FROM industry_news
      WHERE analyzed_at > NOW() - INTERVAL '72 hours'
      ORDER BY relevance_score DESC, published_at DESC
      LIMIT $1
    `, [limit]),
    pool.query('SELECT * FROM industry_news_meta ORDER BY generated_at DESC LIMIT 1'),
  ]);
  return { articles: articlesRes.rows, meta: metaRes.rows[0] ?? null };
}
