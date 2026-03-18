import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, jobsTable, criteriaTable, resumeTable } from "@workspace/db";
import {
  ListJobsResponse,
  GetJobResponse,
  GetJobParams,
  UpdateJobStatusParams,
  UpdateJobStatusBody,
  UpdateJobStatusResponse,
  GenerateJobDocsParams,
  GenerateJobDocsResponse,
} from "@workspace/api-zod";
import { generateTailoredDocs } from "../lib/agent.js";

const router: IRouter = Router();

router.get("/jobs", async (req, res): Promise<void> => {
  const status = req.query.status as string | undefined;

  let query = db.select().from(jobsTable).$dynamic();
  if (status) {
    query = query.where(eq(jobsTable.status, status));
  }

  const jobs = await query.orderBy(jobsTable.matchScore);
  res.json(ListJobsResponse.parse(jobs.reverse()));
});

router.get("/jobs/:id", async (req, res): Promise<void> => {
  const params = GetJobParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(GetJobResponse.parse(job));
});

router.patch("/jobs/:id/status", async (req, res): Promise<void> => {
  const params = UpdateJobStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const body = UpdateJobStatusBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [job] = await db
    .update(jobsTable)
    .set({ status: body.data.status })
    .where(eq(jobsTable.id, params.data.id))
    .returning();

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json(UpdateJobStatusResponse.parse(job));
});

router.post("/jobs/:id/generate-docs", async (req, res): Promise<void> => {
  const params = GenerateJobDocsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, params.data.id));
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const [resume] = await db.select().from(resumeTable).limit(1);
  const [criteria] = await db.select().from(criteriaTable).limit(1);

  if (!resume || !resume.content) {
    res.status(400).json({ error: "Please add your resume first" });
    return;
  }

  const docs = await generateTailoredDocs(
    {
      title: job.title,
      company: job.company,
      location: job.location,
      salary: job.salary,
      applyUrl: job.applyUrl,
      whyGoodFit: job.whyGoodFit,
      matchScore: job.matchScore,
    },
    resume.content,
    criteria?.yourName || "Candidate"
  );

  const [updated] = await db
    .update(jobsTable)
    .set({
      tailoredResume: docs.tailoredResume,
      coverLetter: docs.coverLetter,
    })
    .where(eq(jobsTable.id, params.data.id))
    .returning();

  res.json(GenerateJobDocsResponse.parse(updated));
});

export default router;
