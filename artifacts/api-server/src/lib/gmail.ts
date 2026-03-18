import { google } from "googleapis";

const SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/userinfo.email"];

function getOAuth2Client() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI || `${process.env.REPLIT_DEV_DOMAIN}/api/gmail/callback`;

  if (!clientId || !clientSecret) {
    return null;
  }

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function getAuthUrl(): string | null {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) return null;

  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });
}

export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiryDate?: Date;
  email: string;
} | null> {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) return null;

  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);

  const oauth2 = google.oauth2({ version: "v2", auth: oauth2Client });
  const userInfo = await oauth2.userinfo.get();

  return {
    accessToken: tokens.access_token!,
    refreshToken: tokens.refresh_token || undefined,
    tokenType: tokens.token_type || "Bearer",
    expiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : undefined,
    email: userInfo.data.email || "",
  };
}

export async function sendEmailViaGmail(params: {
  accessToken: string;
  refreshToken?: string | null;
  from: string;
  to: string;
  subject: string;
  htmlBody: string;
}): Promise<void> {
  const oauth2Client = getOAuth2Client();
  if (!oauth2Client) throw new Error("Gmail not configured");

  oauth2Client.setCredentials({
    access_token: params.accessToken,
    refresh_token: params.refreshToken || undefined,
  });

  const gmail = google.gmail({ version: "v1", auth: oauth2Client });

  const messageParts = [
    `From: ${params.from}`,
    `To: ${params.to}`,
    `Subject: ${params.subject}`,
    "Content-Type: text/html; charset=utf-8",
    "",
    params.htmlBody,
  ];

  const message = messageParts.join("\n");
  const encodedMessage = Buffer.from(message).toString("base64url");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: { raw: encodedMessage },
  });
}

export function buildDigestEmail(
  jobs: Array<{
    title: string;
    company: string;
    location: string;
    salary?: string | null;
    applyUrl: string;
    matchScore: number;
    whyGoodFit: string;
    tailoredResume?: string | null;
    coverLetter?: string | null;
  }>
): string {
  const jobsHtml = jobs
    .map(
      (job, i) => `
    <div style="border:1px solid #e2e8f0;border-radius:8px;padding:20px;margin-bottom:24px;">
      <h2 style="margin:0 0 8px;color:#1a202c;">#${i + 1}: ${job.title} at ${job.company}</h2>
      <p style="margin:4px 0;color:#4a5568;"><strong>Location:</strong> ${job.location}</p>
      ${job.salary ? `<p style="margin:4px 0;color:#4a5568;"><strong>Salary:</strong> ${job.salary}</p>` : ""}
      <p style="margin:4px 0;color:#4a5568;"><strong>Match score:</strong> ${job.matchScore}/100</p>
      <p style="margin:8px 0;color:#4a5568;">${job.whyGoodFit}</p>
      <a href="${job.applyUrl}" style="display:inline-block;background:#3182ce;color:white;padding:8px 16px;border-radius:4px;text-decoration:none;margin-top:8px;">View Job →</a>
      ${
        job.tailoredResume || job.coverLetter
          ? `<details style="margin-top:16px;">
          <summary style="cursor:pointer;font-weight:600;color:#2d3748;">Tailored Resume & Cover Letter</summary>
          ${job.coverLetter ? `<h3 style="margin:16px 0 8px;">Cover Letter</h3><pre style="white-space:pre-wrap;font-family:sans-serif;color:#2d3748;">${job.coverLetter}</pre>` : ""}
          ${job.tailoredResume ? `<h3 style="margin:16px 0 8px;">Tailored Resume</h3><pre style="white-space:pre-wrap;font-family:sans-serif;color:#2d3748;">${job.tailoredResume}</pre>` : ""}
        </details>`
          : ""
      }
    </div>
  `
    )
    .join("");

  return `
    <html><body style="font-family:sans-serif;max-width:800px;margin:0 auto;padding:20px;color:#2d3748;">
      <h1 style="color:#1a202c;">Your Daily Job Digest</h1>
      <p style="color:#4a5568;">Found <strong>${jobs.length}</strong> matching jobs today!</p>
      <hr style="border:1px solid #e2e8f0;margin:20px 0;" />
      ${jobsHtml}
      <p style="color:#718096;font-size:12px;margin-top:32px;">Sent by Job Scout Agent</p>
    </body></html>
  `;
}
