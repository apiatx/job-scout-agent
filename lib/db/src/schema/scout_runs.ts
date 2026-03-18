import { pgTable, text, serial, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const scoutRunsTable = pgTable("scout_runs", {
  id: serial("id").primaryKey(),
  status: text("status").notNull().default("running"),
  jobsFound: integer("jobs_found").notNull().default(0),
  emailSent: boolean("email_sent").notNull().default(false),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});

export const insertScoutRunSchema = createInsertSchema(scoutRunsTable).omit({ id: true, startedAt: true });
export type InsertScoutRun = z.infer<typeof insertScoutRunSchema>;
export type ScoutRun = typeof scoutRunsTable.$inferSelect;
