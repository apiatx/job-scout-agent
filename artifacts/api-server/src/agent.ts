import Anthropic from '@anthropic-ai/sdk';
import type { ScrapedJob } from './scraper.js';

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY ?? '',
  ...(process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL
    ? { baseURL: process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL }
    : {}),
});

export interface JobMatch {
  title: string;
  company: string;
  location: string;
  salary?: string;
  applyUrl: string;
  whyGoodFit: string;
  matchScore: number;
  isHardware: boolean;
}

interface CriteriaForAgent {
  targetRoles: string[];
  industries: string[];
  minSalary?: number | null;
  locations: string[];
  mustHave: string[];
  niceToHave: string[];
  avoid: string[];
  preApprovedCompanies?: string[];
}

async function scoreOne(job: ScrapedJob, criteriaText: string, preApprovedSection: string, preApprovedCompanies: string[]): Promise<JobMatch | null> {
  try {
    // Check if this job is from a pre-approved company
    const isPreApproved = preApprovedCompanies.some(
      (name) => name.toLowerCase() === job.company.toLowerCase()
    );
    let companySpecificSection = preApprovedSection;
    if (isPreApproved) {
      companySpecificSection += `\n\nIMPORTANT: This job is from ${job.company} which is on the user's pre-approved companies list. The user has already vetted and approved this company as a target employer. You MUST score this job at least 65 if the role title matches any of the user's target roles, regardless of whether the company sells hardware or software. The only valid reasons to score below 65 for a pre-approved company are: (1) the role title is completely wrong — e.g. engineering, product, marketing, HR, finance, legal — or (2) the job location is outside the user's location preferences.`;
    }

    const prompt = `You are a job matching assistant. Evaluate whether this job matches the candidate's criteria.

LOCATION RULES:
The candidate's preferred locations are listed below in the criteria. Evaluate location fit based on those preferences.
- If the candidate lists specific US locations/regions, reject jobs outside those areas (score 0).
- "Remote" in the candidate's preferences means fully remote roles based in the candidate's preferred country/region are acceptable.
- If a job says "Remote, <State/City>", that location must be in or closely associated with one of the candidate's preferred locations/regions.
- If the candidate has no location preferences, accept any location.
- When in doubt about whether a location matches, lean toward rejecting the job.

${companySpecificSection}

Job:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
URL: ${job.applyUrl}
${job.description ? `Description snippet: ${job.description.slice(0, 1000)}` : ''}

Candidate criteria:
${criteriaText}

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "matchScore": <0-100 integer>,
  "whyGoodFit": "<2-3 sentences explaining fit or why it doesn't match>",
  "isMatch": <true if score >= 50, else false>,
  "isHardware": <true if the role is primarily hardware/infrastructure/networking/storage/semiconductor, false if software>
}`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    if (block.type !== 'text') return null;

    const text = block.text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text) as { matchScore: number; whyGoodFit: string; isMatch: boolean; isHardware?: boolean };
    if (!parsed.isMatch) {
      if (parsed.matchScore >= 30) {
        console.log(`  Claude rejected (score ${parsed.matchScore}): ${job.company} — "${job.title}" — ${job.location} — ${parsed.whyGoodFit?.slice(0, 100)}`);
      }
      return null;
    }

    return {
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      applyUrl: job.applyUrl,
      whyGoodFit: parsed.whyGoodFit,
      matchScore: parsed.matchScore,
      isHardware: parsed.isHardware ?? false,
    };
  } catch {
    return null;
  }
}

// ── Company safety pre-screening for JobSpy results ──
// Filters out pure SaaS / software companies that aren't relevant targets.
// Only called for non-pre-approved companies found via JobSpy.

const companySafetyCache = new Map<string, boolean>();

async function isCompanySafe(companyName: string): Promise<boolean> {
  const cached = companySafetyCache.get(companyName);
  if (cached !== undefined) return cached;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 8,
      messages: [{
        role: 'user',
        content: `Is "${companyName}" a hardware company, cloud infrastructure provider, top AI company, irreplaceable data/database platform, or industrial/energy technology software company? Answer only YES or NO.`,
      }],
    });

    const block = message.content[0];
    const answer = block.type === 'text' ? block.text.trim().toUpperCase() : 'NO';
    const safe = answer.startsWith('YES');
    companySafetyCache.set(companyName, safe);
    return safe;
  } catch {
    // On error, allow the company through to avoid false negatives
    companySafetyCache.set(companyName, true);
    return true;
  }
}

/**
 * Pre-screen JobSpy jobs by filtering out companies that aren't in target sectors.
 * Only evaluates companies NOT in the pre-approved list.
 * Runs all unique company checks up front, then filters the job list.
 */
export async function filterUnsafeCompanies(
  jobs: ScrapedJob[],
  preApprovedCompanies: string[]
): Promise<ScrapedJob[]> {
  const preApprovedLower = new Set(preApprovedCompanies.map((n) => n.toLowerCase()));

  // Collect unique non-pre-approved company names
  const uniqueCompanies = new Set<string>();
  for (const job of jobs) {
    if (!preApprovedLower.has(job.company.toLowerCase())) {
      uniqueCompanies.add(job.company);
    }
  }

  if (uniqueCompanies.size === 0) return jobs;

  console.log(`\n──── COMPANY SAFETY CHECK ──────────────────────────────────`);
  console.log(`Evaluating ${uniqueCompanies.size} unique non-pre-approved companies...`);

  // Evaluate all unique companies in batches of 10
  const companyList = Array.from(uniqueCompanies);
  const BATCH_SIZE = 10;
  for (let i = 0; i < companyList.length; i += BATCH_SIZE) {
    const batch = companyList.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((name) => isCompanySafe(name)));
  }

  // Log results
  let safe = 0;
  let unsafe = 0;
  for (const name of companyList) {
    if (companySafetyCache.get(name)) {
      safe++;
    } else {
      unsafe++;
      console.log(`  ✗ Filtered out: ${name}`);
    }
  }
  console.log(`  Safe: ${safe}, Filtered out: ${unsafe}`);
  console.log(`───────────────────────────────────────────────────────────`);

  // Filter jobs
  return jobs.filter((job) => {
    if (preApprovedLower.has(job.company.toLowerCase())) return true;
    return companySafetyCache.get(job.company) ?? true;
  });
}

export async function scoreJobsWithClaude(jobs: ScrapedJob[], criteria: CriteriaForAgent): Promise<JobMatch[]> {
  if (jobs.length === 0) return [];

  const criteriaText = [
    criteria.targetRoles.length ? `Target roles: ${criteria.targetRoles.join(', ')}` : '',
    criteria.industries.length ? `Industries: ${criteria.industries.join(', ')}` : '',
    criteria.minSalary ? `Minimum salary: $${criteria.minSalary.toLocaleString()} base` : '',
    criteria.locations.length ? `Locations: ${criteria.locations.join(', ')}` : '',
    criteria.mustHave.length ? `Must have: ${criteria.mustHave.join(', ')}` : '',
    criteria.niceToHave.length ? `Nice to have: ${criteria.niceToHave.join(', ')}` : '',
    criteria.avoid.length ? `Avoid: ${criteria.avoid.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  // Build pre-approved companies section for the prompt
  let preApprovedSection = '';
  if (criteria.preApprovedCompanies && criteria.preApprovedCompanies.length > 0) {
    preApprovedSection = `PRE-APPROVED COMPANIES:
The user has pre-approved these specific companies as target employers. If a job is from ANY of these companies, treat the company as an automatic match — only evaluate whether the ROLE TITLE and RESPONSIBILITIES match the user's target roles. Do not penalize or lower the score because of the industry or product type — the user has already decided these companies are good targets.
Pre-approved companies: ${criteria.preApprovedCompanies.join(', ')}
For jobs NOT from the pre-approved list, apply normal scoring criteria.`;
  }

  const CONCURRENCY = 10;
  const results: JobMatch[] = [];

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    console.log(`Scoring batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(jobs.length / CONCURRENCY)} (${batch.length} jobs)...`);
    const batchResults = await Promise.all(batch.map((j) => scoreOne(j, criteriaText, preApprovedSection, criteria.preApprovedCompanies ?? [])));
    for (const r of batchResults) {
      if (r !== null) results.push(r);
    }
  }

  console.log(`Claude scoring complete: ${results.length} matches from ${jobs.length} candidates`);
  return results;
}

export async function researchCompanyWithClaude(companyName: string): Promise<Record<string, unknown>> {
  const prompt = `You are a sales intelligence researcher preparing a briefing for an enterprise account executive interviewing at or preparing for a first call with ${companyName}. Research this company thoroughly using web search. Find the most current information available. Return ONLY a valid JSON object with no other text:
{
  "companyName": "string",
  "oneLiner": "one sentence — what they make and who buys it",
  "overview": "2-3 paragraphs on what they do, why it matters, market position",
  "recentNews": ["3-5 most recent notable news items with dates"],
  "keyProducts": ["main products and solutions relevant to enterprise sales"],
  "whatTheySolve": "the specific pain point they uniquely solve",
  "aiStrategy": "how AI factors into their product and go-to-market right now",
  "competitors": ["top 3-5 direct competitors"],
  "competitiveAdvantage": "what makes them win deals vs competitors",
  "salesMotion": "how they sell — direct vs channel, deal sizes, typical buyer titles",
  "keyExecutives": ["CEO name", "CRO or VP Sales name", "other relevant leaders"],
  "fundingValuation": "market cap or most recent funding round and valuation",
  "revenueGrowth": "most recent revenue figures or growth metrics if public",
  "whyApply": "2-3 sentences on why this is a compelling enterprise sales role specifically",
  "talkingPoints": ["5 specific talking points for an interview or discovery call based on recent news — be specific not generic"],
  "generatedAt": "current ISO timestamp"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }] as unknown as Anthropic.Messages.Tool[],
    messages: [{ role: 'user', content: prompt }],
  });

  // Extract the final text block from the response (after tool use)
  let jsonText = '';
  for (const block of message.content) {
    if (block.type === 'text') {
      jsonText = block.text;
    }
  }

  // Clean and parse JSON
  jsonText = jsonText.trim().replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(jsonText) as Record<string, unknown>;
  return parsed;
}

export async function tailorResumeWithClaude(
  job: { title: string; company: string; location: string; description?: string; why_good_fit?: string; apply_url?: string },
  baseResume: string
): Promise<{ resume: string; coverLetter: string }> {
  const systemPrompt = `You are an elite executive resume writer and career strategist who has helped thousands of senior sales professionals land roles at top-tier technology companies. You specialize in crafting ATS-optimized resumes and compelling cover letters that highlight quantifiable achievements and strategic impact.

Your approach:
- Lead every bullet point with a strong action verb and quantifiable result (revenue generated, deals closed, % quota attainment, team size, territory growth)
- Mirror the exact language, keywords, and qualifications from the job description throughout the resume
- Position the candidate as a strategic revenue driver, not just a salesperson
- Highlight enterprise/strategic selling methodology experience (MEDDPICC, Challenger, Solution Selling, etc.) when relevant
- Emphasize relationships with C-suite buyers and complex deal cycles
- For the cover letter: open with a compelling hook, connect the candidate's track record directly to the company's mission and the role's requirements, and close with confidence and a clear call to action
- Keep the resume to 2 pages max, well-structured with clear sections: Summary, Experience, Key Skills, Education
- Never fabricate information — only reframe and optimize what's in the base resume`;

  const prompt = `Tailor this candidate's resume and write a cover letter for the following role.

JOB DETAILS:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description ? `Description:\n${job.description.slice(0, 3000)}` : ''}
${job.why_good_fit ? `Why it's a good fit: ${job.why_good_fit}` : ''}

CANDIDATE'S BASE RESUME:
${baseResume}

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "resume": "<the full tailored resume text, formatted with clear sections>",
  "coverLetter": "<the full cover letter>"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 8096,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }],
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    return { resume: 'Error generating resume', coverLetter: 'Error generating cover letter' };
  }

  try {
    const text = block.text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text) as { resume: string; coverLetter: string };
    return parsed;
  } catch {
    // If JSON parsing fails, try to extract the text content
    return { resume: block.text, coverLetter: '' };
  }
}
