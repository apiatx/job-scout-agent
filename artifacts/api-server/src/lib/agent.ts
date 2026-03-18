import { anthropic } from "@workspace/integrations-anthropic-ai";
import { batchProcess } from "@workspace/integrations-anthropic-ai/batch";
import type { ScrapedJob } from "./scraper.js";

export interface JobMatch {
  title: string;
  company: string;
  location: string;
  salary?: string;
  applyUrl: string;
  whyGoodFit: string;
  matchScore: number;
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

export async function scoreJobsWithClaude(
  jobs: ScrapedJob[],
  criteria: CriteriaForAgent
): Promise<JobMatch[]> {
  if (jobs.length === 0) return [];

  const criteriaText = `
Target roles: ${criteria.targetRoles.join(", ")}
Industries: ${criteria.industries.join(", ")}
${criteria.minSalary ? `Minimum salary: $${criteria.minSalary.toLocaleString()} base` : ""}
Locations: ${criteria.locations.join(", ")}
Must have: ${criteria.mustHave.join(", ")}
Nice to have: ${criteria.niceToHave.join(", ")}
Avoid: ${criteria.avoid.join(", ")}
`.trim();

  const results = await batchProcess(
    jobs,
    async (job: ScrapedJob) => {
      const prompt = `You are a job matching assistant. Evaluate whether this job matches the candidate's criteria.

Job:
Title: ${job.title}
Company: ${job.company}
Location: ${job.location}
URL: ${job.applyUrl}
${job.description ? `Description snippet: ${job.description.slice(0, 1000)}` : ""}

Candidate criteria:
${criteriaText}

Respond ONLY with a JSON object (no markdown, no extra text):
{
  "matchScore": <0-100 integer>,
  "whyGoodFit": "<2-3 sentences explaining fit or why it doesn't match>",
  "isMatch": <true if score >= 60, else false>
}`;

      const message = await anthropic.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      });

      const block = message.content[0];
      if (block.type !== "text") return null;

      try {
        const text = block.text.trim().replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(text) as {
          matchScore: number;
          whyGoodFit: string;
          isMatch: boolean;
        };

        if (!parsed.isMatch) return null;

        return {
          title: job.title,
          company: job.company,
          location: job.location,
          salary: job.salary,
          applyUrl: job.applyUrl,
          whyGoodFit: parsed.whyGoodFit,
          matchScore: parsed.matchScore,
        } satisfies JobMatch;
      } catch {
        return null;
      }
    },
    { concurrency: 3, retries: 3 }
  );

  return results.filter((r): r is JobMatch => r !== null);
}

export async function generateTailoredDocs(
  job: JobMatch & { salary?: string | null },
  resumeContent: string,
  yourName: string
): Promise<{ tailoredResume: string; coverLetter: string }> {
  const prompt = `You are a professional resume writer and career coach helping ${yourName} apply for a job.

Job:
Title: ${job.title} at ${job.company}
Location: ${job.location}
${job.salary ? `Salary: ${job.salary}` : ""}
Why it's a good fit: ${job.whyGoodFit}

Candidate's base resume:
${resumeContent}

Please do two things:

1. Rewrite the resume summary and reorder/reword bullet points to emphasize experience most relevant to THIS specific role. Do not fabricate experience — only emphasize and reframe what's already there.

2. Write a compelling cover letter (3 paragraphs max) that:
   - Opens with why ${yourName} is excited about this specific company and role
   - Connects their experience to the company's needs
   - Closes with a confident call to action

Format your response EXACTLY like this (with the === markers):

=== TAILORED RESUME ===
[resume content here]

=== COVER LETTER ===
[cover letter content here]`;

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{ role: "user", content: prompt }],
  });

  const block = message.content[0];
  if (block.type !== "text") {
    return { tailoredResume: "", coverLetter: "" };
  }

  const text = block.text;
  const resumeMatch = text.match(/=== TAILORED RESUME ===\n([\s\S]*?)(?:=== COVER LETTER ===|$)/);
  const coverMatch = text.match(/=== COVER LETTER ===\n([\s\S]*?)$/);

  return {
    tailoredResume: resumeMatch ? resumeMatch[1].trim() : text,
    coverLetter: coverMatch ? coverMatch[1].trim() : "",
  };
}
