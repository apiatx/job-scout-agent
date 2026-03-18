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
        targetRoles: [
          "Enterprise Account Executive",
          "Strategic Account Executive",
          "Senior Account Executive",
          "Regional Sales Manager",
          "Sales Director",
          "Major Account Executive",
          "Named Account Executive",
        ],
        industries: [
          "AI Infrastructure",
          "Data Center Hardware",
          "Semiconductors",
          "Networking Hardware",
          "Storage Hardware",
          "Optical Networking",
          "Edge Computing",
          "Power & Cooling Infrastructure",
          "Server Hardware",
        ],
        minSalary: 150000,
        locations: ["Remote", "New York", "San Francisco", "Austin", "Boston", "Seattle", "Chicago"],
        mustHave: [
          "enterprise sales",
          "quota carrying",
          "hardware OR infrastructure OR networking OR storage OR semiconductor OR compute OR optical",
        ],
        niceToHave: ["AI", "data center", "GPU", "NVIDIA", "hunter", "new logo"],
        avoid: ["SDR", "BDR", "inbound only", "SMB only", "pure SaaS", "marketing", "recruiting"],
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
