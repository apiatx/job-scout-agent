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
}

async function scoreOne(job: ScrapedJob, criteriaText: string): Promise<JobMatch | null> {
  try {
    const prompt = `You are a job matching assistant. Evaluate whether this job matches the candidate's criteria.

CRITICAL LOCATION RULE:
The candidate's preferred locations are listed below. You MUST reject any job (score 0, isMatch false) whose location does NOT fall within one of the candidate's preferred locations or regions.
- "Remote" in the candidate's preferences means fully remote roles with NO specific state/city requirement are acceptable.
- If a job says "Remote, <State>" or "Remote, <City>", that state/city MUST be in or closely associated with one of the candidate's preferred locations/regions.
  For example, if the candidate wants "South Carolina, Georgia, Florida, South East, East Coast, South", then "Remote, Washington" or "Remote, Ohio" or "Remote, Massachusetts" or "Remote, Virginia" do NOT qualify.
- STRICT regional definitions — use ONLY these states for each region:
  "South East" or "Southeast": NC, SC, GA, FL — ONLY these four states. No others.
  "East Coast": Same as Southeast for this candidate — NC, SC, GA, FL only.
  "South": For this candidate, "South" means ONLY NC, SC, GA, FL. No other states. REJECT AL, TN, TX, KY, MS, LA, AR, and all others.
  "United States": US-based roles are acceptable ONLY if listed as fully "Remote" with NO specific state/city, OR the state is in one of the candidate's preferred regions above.
- Virginia is NOT in Southeast, NOT in East Coast, and NOT in South for this candidate. REJECT Virginia jobs.
- Washington, Massachusetts, California, New York, Oregon, Colorado, Illinois, Ohio, Michigan, Minnesota, etc. are all OUTSIDE the candidate's regions. REJECT them.
- If a job lists multiple locations (e.g., "San Francisco, CA / Sunnyvale, CA"), ALL locations must be in the candidate's preferred areas, OR the job must also offer a remote option in a preferred area.
- When in doubt about whether a location matches, REJECT the job. Be very strict.

Job:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
URL: ${job.applyUrl}
${job.description ? `Description snippet: ${job.description.slice(0, 1000)}` : ''}

Candidate criteria:
${criteriaText}

Software exceptions: Oracle database, Snowflake, Databricks, NetSuite are acceptable even though they are software.

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "matchScore": <0-100 integer>,
  "whyGoodFit": "<2-3 sentences explaining fit or why it doesn't match>",
  "isMatch": <true if score >= 60, else false>,
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
    if (!parsed.isMatch) return null;

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

export async function scoreJobsWithClaude(jobs: ScrapedJob[], criteria: CriteriaForAgent): Promise<JobMatch[]> {
  if (jobs.length === 0) return [];

  const criteriaText = [
    `Target roles: ${criteria.targetRoles.join(', ')}`,
    `Industries: ${criteria.industries.join(', ')}`,
    criteria.minSalary ? `Minimum salary: $${criteria.minSalary.toLocaleString()} base` : '',
    `Locations: ${criteria.locations.join(', ')}`,
    `Must have: ${criteria.mustHave.join(', ')}`,
    `Nice to have: ${criteria.niceToHave.join(', ')}`,
    `Avoid: ${criteria.avoid.join(', ')}`,
  ].filter(Boolean).join('\n');

  const CONCURRENCY = 10;
  const results: JobMatch[] = [];

  for (let i = 0; i < jobs.length; i += CONCURRENCY) {
    const batch = jobs.slice(i, i + CONCURRENCY);
    console.log(`Scoring batch ${Math.floor(i / CONCURRENCY) + 1}/${Math.ceil(jobs.length / CONCURRENCY)} (${batch.length} jobs)...`);
    const batchResults = await Promise.all(batch.map((j) => scoreOne(j, criteriaText)));
    for (const r of batchResults) {
      if (r !== null) results.push(r);
    }
  }

  console.log(`Claude scoring complete: ${results.length} matches from ${jobs.length} candidates`);
  return results;
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
