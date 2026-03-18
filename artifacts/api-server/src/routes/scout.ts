import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, scoutRunsTable, companiesTable, criteriaTable, jobsTable, resumeTable, gmailTokensTable } from "@workspace/db";
import { RunScoutResponse, GetScoutStatusResponse } from "@workspace/api-zod";
import { scrapeGreenhouseJobs, scrapeLeverJobs, scrapePlainWebsite, scrapeWorkdayJobs } from "../lib/scraper.js";
import { scoreJobsWithClaude } from "../lib/agent.js";
import { sendEmailViaGmail, buildDigestEmail } from "../lib/gmail.js";

// On startup, mark any stale "running" records (from a previous crash/restart) as failed
db.update(scoutRunsTable)
  .set({ status: "failed", error: "Server restarted — run was abandoned", completedAt: new Date() })
  .where(eq(scoutRunsTable.status, "running"))
  .then(() => {})
  .catch(console.error);

let scoutRunning = false;

const WORKDAY_COMPANIES = [
  { slug: "cisco", domain: "cisco.wd5.myworkdayjobs.com", name: "Cisco" },
  { slug: "nvidia", domain: "nvidia.wd5.myworkdayjobs.com", name: "NVIDIA", careerSite: "NVIDIAExternalCareerSite" },
  { slug: "dell", domain: "dell.wd1.myworkdayjobs.com", name: "Dell Technologies", careerSite: "ExternalNonPublic" },
];

const router: IRouter = Router();

router.get("/scout/status", async (_req, res): Promise<void> => {
  const runs = await db
    .select()
    .from(scoutRunsTable)
    .orderBy(desc(scoutRunsTable.startedAt))
    .limit(20);

  const serialized = runs.map((r) => ({
    ...r,
    completedAt: r.completedAt instanceof Date ? r.completedAt.toISOString() : r.completedAt,
  }));
  res.json(GetScoutStatusResponse.parse(serialized));
});

router.post("/scout/run", async (_req, res): Promise<void> => {
  if (scoutRunning) {
    res.status(409).json({ error: "A scout run is already in progress. Please wait for it to finish." });
    return;
  }

  const [run] = await db
    .insert(scoutRunsTable)
    .values({ status: "running", jobsFound: 0, emailSent: false })
    .returning();

  res.json(RunScoutResponse.parse({
    runId: run.id,
    jobsFound: 0,
    emailSent: false,
    message: "Scout run started in background",
  }));

  scoutRunning = true;
  runScoutInBackground(run.id).catch(console.error).finally(() => { scoutRunning = false; });
});

async function runScoutInBackground(runId: number) {
  try {
    const companies = await db.select().from(companiesTable);
    const [criteria] = await db.select().from(criteriaTable).limit(1);
    const [resume] = await db.select().from(resumeTable).limit(1);

    if (!criteria) {
      await db.update(scoutRunsTable)
        .set({ status: "failed", error: "No criteria configured", completedAt: new Date() })
        .where(eq(scoutRunsTable.id, runId));
      return;
    }

    const allJobs: Awaited<ReturnType<typeof scrapeGreenhouseJobs>> = [];

    const greenhouse = companies.filter((c) => c.atsType === "greenhouse" && c.atsSlug);
    const lever = companies.filter((c) => c.atsType === "lever" && c.atsSlug);
    const plain = companies.filter((c) => (c.atsType === "workday" || c.atsType === "other") && c.careersUrl);

    console.log(`\n--- Scanning ${greenhouse.length} Greenhouse companies ---`);
    for (const company of greenhouse) {
      const jobs = await scrapeGreenhouseJobs(company.atsSlug!, company.name);
      allJobs.push(...jobs);
    }

    console.log(`\n--- Scanning ${lever.length} Lever companies ---`);
    for (const company of lever) {
      const jobs = await scrapeLeverJobs(company.atsSlug!, company.name);
      allJobs.push(...jobs);
    }

    if (plain.length > 0) {
      console.log(`\n--- Scanning ${plain.length} plain career pages ---`);
      for (const company of plain) {
        const jobs = await scrapePlainWebsite(company.careersUrl!, company.name);
        allJobs.push(...jobs);
      }
    }

    console.log(`\n--- Scanning ${WORKDAY_COMPANIES.length} Workday companies ---`);
    for (const company of WORKDAY_COMPANIES) {
      const jobs = await scrapeWorkdayJobs(company.slug, company.domain, company.name, company.careerSite);
      allJobs.push(...jobs);
    }

    console.log(`\nTotal: scraped ${allJobs.length} job listings across all companies`);

    // Pre-filter to sales-relevant titles before hitting Claude — avoids scoring
    // thousands of engineering/PM/marketing roles. Kept narrow so Claude only sees
    // a small set of plausible AE / Sales Director roles.
    const SALES_INCLUDE = /\b(account\s+executive|sales\s+director|director\s+of\s+sales|vp\s+of?\s+sales|regional\s+sales|territory\s+sales|named\s+account|major\s+account|strategic\s+account|enterprise\s+account)\b/i;
    const SALES_EXCLUDE = /\b(engineer|developer|software|scientist|analyst|marketing|designer|recruiter|\bhr\b|finance|accounting|legal|product\s+manager|program\s+manager|project\s+manager|intern|coordinator|specialist|support|customer\s+success|operations|architect|data\b|cloud\s+sales\s+engineer)\b/i;

    const filteredJobs = allJobs.filter((job) => {
      const t = job.title;
      return SALES_INCLUDE.test(t) && !SALES_EXCLUDE.test(t);
    });

    // Hard cap: never send more than 80 jobs to Claude regardless of filter output
    const MAX_CLAUDE_JOBS = 80;
    const jobsToScore = filteredJobs.length > MAX_CLAUDE_JOBS
      ? filteredJobs.slice(0, MAX_CLAUDE_JOBS)
      : filteredJobs;

    console.log(`Pre-filter: ${filteredJobs.length} of ${allJobs.length} jobs matched; sending ${jobsToScore.length} to Claude`);

    if (jobsToScore.length === 0) {
      await db.update(scoutRunsTable)
        .set({ status: "completed", jobsFound: 0, completedAt: new Date() })
        .where(eq(scoutRunsTable.id, runId));
      return;
    }

    const matches = await scoreJobsWithClaude(jobsToScore, {
      targetRoles: criteria.targetRoles || [],
      industries: criteria.industries || [],
      minSalary: criteria.minSalary,
      locations: criteria.locations || [],
      mustHave: criteria.mustHave || [],
      niceToHave: criteria.niceToHave || [],
      avoid: criteria.avoid || [],
    });

    const insertedJobs = [];
    for (const match of matches) {
      const [inserted] = await db.insert(jobsTable).values({
        title: match.title,
        company: match.company,
        location: match.location,
        salary: match.salary,
        applyUrl: match.applyUrl,
        whyGoodFit: match.whyGoodFit,
        matchScore: match.matchScore,
        status: "new",
        scoutRunId: runId,
      }).returning();
      insertedJobs.push(inserted);
    }

    let emailSent = false;
    const [gmailToken] = await db.select().from(gmailTokensTable).limit(1);

    if (gmailToken && insertedJobs.length > 0 && criteria.yourEmail && resume?.content) {
      try {
        const topJobs = insertedJobs.slice(0, 5);
        const emailBody = buildDigestEmail(topJobs.map((j) => ({
          title: j.title,
          company: j.company,
          location: j.location,
          salary: j.salary,
          applyUrl: j.applyUrl,
          matchScore: j.matchScore,
          whyGoodFit: j.whyGoodFit,
        })));

        await sendEmailViaGmail({
          accessToken: gmailToken.accessToken,
          refreshToken: gmailToken.refreshToken,
          from: gmailToken.email,
          to: criteria.yourEmail,
          subject: `🎯 Your Daily Job Digest — ${insertedJobs.length} matches found`,
          htmlBody: emailBody,
        });

        emailSent = true;
      } catch (e) {
        console.error("Failed to send email:", e);
      }
    }

    await db.update(scoutRunsTable)
      .set({
        status: "completed",
        jobsFound: insertedJobs.length,
        emailSent,
        completedAt: new Date(),
      })
      .where(eq(scoutRunsTable.id, runId));

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    await db.update(scoutRunsTable)
      .set({ status: "failed", error: msg, completedAt: new Date() })
      .where(eq(scoutRunsTable.id, runId));
  }
}

export default router;
