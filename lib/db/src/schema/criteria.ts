import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const criteriaTable = pgTable("criteria", {
  id: serial("id").primaryKey(),
  targetRoles: text("target_roles").array().notNull().default([]),
  industries: text("industries").array().notNull().default([]),
  minSalary: integer("min_salary"),
  locations: text("locations").array().notNull().default([]),
  mustHave: text("must_have").array().notNull().default([]),
  niceToHave: text("nice_to_have").array().notNull().default([]),
  avoid: text("avoid").array().notNull().default([]),
  yourName: text("your_name").notNull().default(""),
  yourEmail: text("your_email").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertCriteriaSchema = createInsertSchema(criteriaTable).omit({ id: true });
export type InsertCriteria = z.infer<typeof insertCriteriaSchema>;
export type Criteria = typeof criteriaTable.$inferSelect;
