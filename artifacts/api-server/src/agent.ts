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
  source: string;
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

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "matchScore": <0-100 integer>,
  "whyGoodFit": "<2-3 sentences explaining fit or why it doesn't match>",
  "isMatch": <true if score >= 60, else false>
}`;

    const message = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = message.content[0];
    if (block.type !== 'text') return null;

    const text = block.text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text) as { matchScore: number; whyGoodFit: string; isMatch: boolean };
    if (!parsed.isMatch) return null;

    return {
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      applyUrl: job.applyUrl,
      whyGoodFit: parsed.whyGoodFit,
      matchScore: parsed.matchScore,
      source: job.source,
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
    const batchResults = await Promise.all(batch.map((j) => scoreOne(j, criteriaText)));
    for (const r of batchResults) {
      if (r !== null) results.push(r);
    }
  }

  return results;
}

export async function tailorResumeWithClaude(
  jobTitle: string,
  jobCompany: string,
  jobDescription: string,
  baseResume: string
): Promise<{ tailoredResume: string; coverLetter: string }> {
  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 4096,
    messages: [
      {
        role: 'user',
        content: `You are a professional resume writer. Tailor the candidate's resume and write a cover letter for the following job.

Job Title: ${jobTitle}
Company: ${jobCompany}
Job Description:
${jobDescription.slice(0, 3000)}

Base Resume:
${baseResume.slice(0, 4000)}

Respond ONLY with a JSON object (no markdown fences):
{
  "tailoredResume": "<full tailored resume text, preserving formatting with newlines>",
  "coverLetter": "<professional cover letter text>"
}`,
      },
    ],
  });

  const block = message.content[0];
  if (block.type !== 'text') {
    return { tailoredResume: baseResume, coverLetter: '' };
  }

  try {
    const text = block.text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(text) as { tailoredResume: string; coverLetter: string };
    return parsed;
  } catch {
    return { tailoredResume: baseResume, coverLetter: block.text };
  }
}
