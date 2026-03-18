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
  const prompt = `You are a professional resume writer. Given the candidate's base resume and a specific job, create:
1. A tailored resume optimized for this specific role
2. A compelling cover letter

Job Details:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
${job.description ? `Description: ${job.description.slice(0, 2000)}` : ''}
${job.why_good_fit ? `Why it's a good fit: ${job.why_good_fit}` : ''}

Base Resume:
${baseResume}

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "resume": "<the full tailored resume text, formatted with clear sections>",
  "coverLetter": "<the full cover letter>"
}`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
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
