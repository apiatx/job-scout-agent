import { Router, type IRouter } from "express";
import { desc, eq } from "drizzle-orm";
import { db, scoutRunsTable, companiesTable, criteriaTable, jobsTable, resumeTable, gmailTokensTable } from "@workspace/db";
import { RunScoutResponse, GetScoutStatusResponse } from "@workspace/api-zod";
import { scrapeGreenhouseJobs, scrapeLeverJobs } from "../lib/scraper.js";
import { scoreJobsWithClaude } from "../lib/agent.js";
import { sendEmailViaGmail, buildDigestEmail } from "../lib/gmail.js";

const router: IRouter = Router();

router.get("/scout/status", async (_req, res): Promise<void> => {
  const runs = await db
    .select()
    .from(scoutRunsTable)
    .orderBy(desc(scoutRunsTable.startedAt))
    .limit(20);

  res.json(GetScoutStatusResponse.parse(runs));
});

router.post("/scout/run", async (_req, res): Promise<void> => {
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

  runScoutInBackground(run.id).catch(console.error);
});

async function runScoutInBackground(runId: number) {
  try {
    const companies = await db.select().from(companiesTable);
    const [criteria] = await db.select().from(criteriaTable).limit(1);
    const [resume] = await db.select().from(resumeTable).limit(1);

    if (!criteria) {
      await db.update(scoutRunsTable)
        .set({ status: "failed", error: "No criteria configured", completedAt: new Date() })
        .where((t) => t.id.eq(runId));
      return;
    }

    const allJobs: Awaited<ReturnType<typeof scrapeGreenhouseJobs>> = [];

    for (const company of companies) {
      if (company.atsType === "greenhouse" && company.atsSlug) {
        const jobs = await scrapeGreenhouseJobs(company.atsSlug);
        allJobs.push(...jobs.map((j) => ({ ...j, company: company.name })));
      } else if (company.atsType === "lever" && company.atsSlug) {
        const jobs = await scrapeLeverJobs(company.atsSlug);
        allJobs.push(...jobs.map((j) => ({ ...j, company: company.name })));
      }
    }

    if (allJobs.length === 0) {
      await db.update(scoutRunsTable)
        .set({ status: "completed", jobsFound: 0, completedAt: new Date() })
        .where(eq(scoutRunsTable.id, runId));
      return;
    }

    const matches = await scoreJobsWithClaude(allJobs, {
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
