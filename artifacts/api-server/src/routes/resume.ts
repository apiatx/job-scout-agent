import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, resumeTable } from "@workspace/db";
import { GetResumeResponse, UpdateResumeBody, UpdateResumeResponse } from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/resume", async (_req, res): Promise<void> => {
  let [resume] = await db.select().from(resumeTable).limit(1);

  if (!resume) {
    const [created] = await db.insert(resumeTable).values({ content: "" }).returning();
    resume = created;
  }

  res.json(GetResumeResponse.parse(resume));
});

router.put("/resume", async (req, res): Promise<void> => {
  const parsed = UpdateResumeBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let [existing] = await db.select().from(resumeTable).limit(1);

  if (!existing) {
    const [created] = await db.insert(resumeTable).values(parsed.data).returning();
    res.json(UpdateResumeResponse.parse(created));
    return;
  }

  const [updated] = await db.update(resumeTable).set(parsed.data).where(eq(resumeTable.id, existing.id)).returning();
  res.json(UpdateResumeResponse.parse(updated));
});

export default router;
