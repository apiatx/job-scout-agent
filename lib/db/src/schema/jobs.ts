import { pgTable, text, serial, integer, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobsTable = pgTable("jobs", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  company: text("company").notNull(),
  location: text("location").notNull().default("Unknown"),
  salary: text("salary"),
  applyUrl: text("apply_url").notNull(),
  whyGoodFit: text("why_good_fit").notNull().default(""),
  matchScore: integer("match_score").notNull().default(0),
  status: text("status").notNull().default("new"),
  tailoredResume: text("tailored_resume"),
  coverLetter: text("cover_letter"),
  scoutRunId: integer("scout_run_id"),
  foundAt: timestamp("found_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertJobSchema = createInsertSchema(jobsTable).omit({ id: true, foundAt: true });
export type InsertJob = z.infer<typeof insertJobSchema>;
export type Job = typeof jobsTable.$inferSelect;
