import { Router, type IRouter } from "express";
import { db, gmailTokensTable, criteriaTable, jobsTable } from "@workspace/db";
import {
  GetGmailStatusResponse,
  GetGmailSetupUrlResponse,
  GmailCallbackResponse,
  DisconnectGmailResponse,
  SendDigestEmailResponse,
} from "@workspace/api-zod";
import { getAuthUrl, exchangeCodeForTokens, sendEmailViaGmail, buildDigestEmail } from "../lib/gmail.js";

const router: IRouter = Router();

router.get("/gmail/status", async (_req, res): Promise<void> => {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    res.json(GetGmailStatusResponse.parse({
      connected: false,
      email: null,
      message: "Gmail OAuth credentials not configured. Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to your secrets.",
    }));
    return;
  }

  const [token] = await db.select().from(gmailTokensTable).limit(1);

  if (!token) {
    res.json(GetGmailStatusResponse.parse({
      connected: false,
      email: null,
      message: "Gmail not connected. Click 'Connect Gmail' to authorize.",
    }));
    return;
  }

  res.json(GetGmailStatusResponse.parse({
    connected: true,
    email: token.email,
    message: `Connected as ${token.email}`,
  }));
});

router.get("/gmail/setup-url", async (_req, res): Promise<void> => {
  const url = getAuthUrl();

  if (!url) {
    res.status(400).json({ error: "Gmail OAuth not configured. Add GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET to your secrets." });
    return;
  }

  res.json(GetGmailSetupUrlResponse.parse({
    url,
    instructions: "Click the link to authorize Gmail access. You will be redirected back after authorizing.",
  }));
});

router.get("/gmail/callback", async (req, res): Promise<void> => {
  const code = req.query.code as string | undefined;
  const error = req.query.error as string | undefined;

  if (error || !code) {
    res.json(GmailCallbackResponse.parse({
      connected: false,
      email: null,
      message: error || "No authorization code received",
    }));
    return;
  }

  try {
    const tokens = await exchangeCodeForTokens(code);
    if (!tokens) {
      res.json(GmailCallbackResponse.parse({
        connected: false,
        email: null,
        message: "Failed to exchange code for tokens",
      }));
      return;
    }

    await db.delete(gmailTokensTable);
    await db.insert(gmailTokensTable).values({
      email: tokens.email,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      tokenType: tokens.tokenType,
      expiryDate: tokens.expiryDate,
    });

    res.redirect("/?gmail=connected");
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    res.json(GmailCallbackResponse.parse({
      connected: false,
      email: null,
      message: `Error: ${msg}`,
    }));
  }
});

router.post("/gmail/disconnect", async (_req, res): Promise<void> => {
  await db.delete(gmailTokensTable);
  res.json(DisconnectGmailResponse.parse({
    connected: false,
    email: null,
    message: "Gmail disconnected",
  }));
});

router.post("/gmail/send-digest", async (_req, res): Promise<void> => {
  const [token] = await db.select().from(gmailTokensTable).limit(1);
  const [criteria] = await db.select().from(criteriaTable).limit(1);

  if (!token) {
    res.status(400).json({ error: "Gmail not connected" });
    return;
  }

  if (!criteria?.yourEmail) {
    res.status(400).json({ error: "No recipient email configured in criteria" });
    return;
  }

  const jobs = await db
    .select()
    .from(jobsTable)
    .limit(10);

  const topJobs = jobs
    .sort((a, b) => b.matchScore - a.matchScore)
    .slice(0, 5);

  if (topJobs.length === 0) {
    res.json(SendDigestEmailResponse.parse({
      success: false,
      message: "No jobs found to send",
      jobsSent: 0,
    }));
    return;
  }

  try {
    const emailBody = buildDigestEmail(topJobs.map((j) => ({
      title: j.title,
      company: j.company,
      location: j.location,
      salary: j.salary,
      applyUrl: j.applyUrl,
      matchScore: j.matchScore,
      whyGoodFit: j.whyGoodFit,
      tailoredResume: j.tailoredResume,
      coverLetter: j.coverLetter,
    })));

    await sendEmailViaGmail({
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      from: token.email,
      to: criteria.yourEmail,
      subject: `🎯 Job Scout Digest — ${topJobs.length} top matches`,
      htmlBody: emailBody,
    });

    res.json(SendDigestEmailResponse.parse({
      success: true,
      message: `Sent ${topJobs.length} jobs to ${criteria.yourEmail}`,
      jobsSent: topJobs.length,
    }));
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    res.status(500).json({ error: `Failed to send email: ${msg}` });
  }
});

export default router;
