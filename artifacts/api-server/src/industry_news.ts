import Parser from 'rss-parser';
import { Pool } from 'pg';
import Anthropic from '@anthropic-ai/sdk';

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

const CLAUDE_MODEL = 'claude-sonnet-4-6';

export async function analyzeArticleBatch(
  articles: Array<{ url: string; title: string; source: string; description: string }>,
  _legacyKey: string
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
  if (!articles.length) return [];

  const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '';
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({ apiKey });

  const articlesText = articles.map((a, i) =>
    `[${i + 1}] SOURCE: ${a.source}\nTITLE: ${a.title}\nURL: ${a.url}\nDESCRIPTION: ${a.description || 'N/A'}`
  ).join('\n\n---\n\n');

  const prompt = `You are a B2B sales intelligence analyst. For each news article below, research the primary company being covered and produce sales intelligence.

Use your search capability to look up current information about each company: headcount, funding stage, recent hires, open sales roles, territory expansion.

ARTICLES TO ANALYZE:
${articlesText}

Return a JSON array (one object per article, same order). Each object MUST include:
{
  "article_index": 1,
  "company_name": "Primary company covered (or 'Multiple' if general)",
  "summary": "2-3 sentence summary of why this matters for B2B sales reps",
  "why_it_matters": "Specific sales angle — is this company buying? selling? expanding? launching?",
  "hiring_signal": "STRONG/MODERATE/LOW/NONE — explain if they're building sales teams and what roles",
  "sales_territory": "Geographic focus if determinable — e.g., 'North America', 'EMEA', 'Global', 'Unknown'",
  "funding_stage": "Seed/Series A/B/C/D/E/Public/Profitable/Unknown + amount if mentioned",
  "employee_count_est": "Estimated employee count (e.g., '50-100', '500-1000', '10,000+')",
  "relevance_score": 0-100 (how relevant is this for a B2B enterprise software sales rep),
  "sector": "Primary sector: SaaS/Cybersecurity/Infrastructure/Hardware/AI/Fintech/HealthTech/Other",
  "tags": ["array", "of", "3-6", "relevant", "tags"]
}

Respond ONLY with valid JSON array, no markdown, no explanation.`;

  try {
    const response = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }] as any[],
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text)
      .join('\n');

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in Claude response');

    const parsed: any[] = JSON.parse(jsonMatch[0]);
    return parsed.map((item: any) => ({
      url: articles[(item.article_index ?? 1) - 1]?.url ?? '',
      company_name: item.company_name ?? 'Unknown',
      summary: item.summary ?? '',
      why_it_matters: item.why_it_matters ?? '',
      hiring_signal: item.hiring_signal ?? 'UNKNOWN',
      sales_territory: item.sales_territory ?? 'Unknown',
      funding_stage: item.funding_stage ?? 'Unknown',
      employee_count_est: item.employee_count_est ?? 'Unknown',
      relevance_score: Math.min(100, Math.max(0, Number(item.relevance_score) || 0)),
      sector: item.sector ?? 'Other',
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
    }));
  } catch (err) {
    console.error(`[IndustryNews] Claude analysis failed:`, (err as Error).message);
    throw err;
  }
}

export async function refreshIndustryNews(pool: Pool, _legacyKey: string): Promise<{
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
    return { inserted: 0, analyzed: 0, sources: 0, model: CLAUDE_MODEL };
  }

  // Analyze in batches of 6
  const BATCH = 6;
  let inserted = 0;
  const uniqueSources = new Set<string>();

  for (let i = 0; i < Math.min(newArticles.length, 48); i += BATCH) {
    const batch = newArticles.slice(i, i + BATCH);
    batch.forEach(a => uniqueSources.add(a.source));
    try {
      const analyzed = await analyzeArticleBatch(batch, '');
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

  await pool.query(
    `INSERT INTO industry_news_meta (id, article_count, model_used, sources_fetched, generated_at)
     VALUES (1,$1,$2,$3,NOW())
     ON CONFLICT (id) DO UPDATE SET article_count = EXCLUDED.article_count,
       model_used = EXCLUDED.model_used, sources_fetched = EXCLUDED.sources_fetched,
       generated_at = NOW()`,
    [inserted, CLAUDE_MODEL, uniqueSources.size]
  );

  console.log(`[IndustryNews] Done — ${inserted} articles inserted/updated`);
  return { inserted, analyzed: newArticles.length, sources: uniqueSources.size, model: CLAUDE_MODEL };
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
