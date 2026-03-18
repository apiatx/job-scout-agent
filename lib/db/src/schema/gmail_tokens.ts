import { pgTable, text, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const gmailTokensTable = pgTable("gmail_tokens", {
  id: serial("id").primaryKey(),
  email: text("email").notNull(),
  accessToken: text("access_token").notNull(),
  refreshToken: text("refresh_token"),
  tokenType: text("token_type").notNull().default("Bearer"),
  expiryDate: timestamp("expiry_date", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertGmailTokenSchema = createInsertSchema(gmailTokensTable).omit({ id: true, createdAt: true });
export type InsertGmailToken = z.infer<typeof insertGmailTokenSchema>;
export type GmailToken = typeof gmailTokensTable.$inferSelect;
