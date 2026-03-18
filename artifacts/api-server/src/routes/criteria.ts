import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, criteriaTable } from "@workspace/db";
import {
  GetCriteriaResponse,
  UpdateCriteriaBody,
  UpdateCriteriaResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/criteria", async (_req, res): Promise<void> => {
  let [criteria] = await db.select().from(criteriaTable).limit(1);

  if (!criteria) {
    const [created] = await db
      .insert(criteriaTable)
      .values({
        targetRoles: ["Enterprise Account Executive", "Senior Account Executive"],
        industries: ["SaaS", "API tools", "Developer tools"],
        minSalary: 150000,
        locations: ["Remote", "New York", "San Francisco"],
        mustHave: ["enterprise sales", "SaaS"],
        niceToHave: ["API", "developer tools"],
        avoid: ["SDR", "BDR", "SMB only"],
        yourName: "",
        yourEmail: "",
      })
      .returning();
    criteria = created;
  }

  res.json(GetCriteriaResponse.parse(criteria));
});

router.put("/criteria", async (req, res): Promise<void> => {
  const parsed = UpdateCriteriaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  let [existing] = await db.select().from(criteriaTable).limit(1);

  if (!existing) {
    const [created] = await db
      .insert(criteriaTable)
      .values(parsed.data)
      .returning();
    res.json(UpdateCriteriaResponse.parse(created));
    return;
  }

  const [updated] = await db
    .update(criteriaTable)
    .set(parsed.data)
    .where(eq(criteriaTable.id, existing.id))
    .returning();

  res.json(UpdateCriteriaResponse.parse(updated));
});

export default router;
