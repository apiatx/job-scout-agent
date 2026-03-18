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
  const jobCount = jobs.length;
  const topScore = jobs.length > 0 ? Math.max(...jobs.map((j) => j.matchScore)) : 0;
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "2-digit",
    year: "numeric",
  });
  const year = new Date().getFullYear().toString();

  const jobCards = jobs
    .map((job, i) => {
      const rank = i + 1;
      const rankLabel = rank === 1 ? "Best fit" : `#${rank}`;
      const scoreBarWidth = `${job.matchScore}%`;
      const resume = (job.tailoredResume || "").slice(0, 1500);
      const resumeTruncated = (job.tailoredResume || "").length > 1500;
      const cover = (job.coverLetter || "").slice(0, 1000);
      const coverTruncated = (job.coverLetter || "").length > 1000;

      return `
        <div style="background:#161616;border:1px solid #2a2a2a;border-radius:12px;margin-bottom:20px;overflow:hidden;">

          <div style="padding:20px 24px 14px;border-bottom:1px solid #222;">
            <div style="font-size:10px;color:#555;letter-spacing:0.1em;text-transform:uppercase;margin-bottom:8px;">Match #${String(rank).padStart(2, "0")} — ${rankLabel}</div>
            <div style="font-size:17px;font-weight:600;color:#f0ede6;margin-bottom:4px;">${job.title}</div>
            <div style="font-size:14px;color:#c8a96e;font-weight:500;">${job.company}</div>
          </div>

          <div style="padding:12px 24px;border-bottom:1px solid #1e1e1e;font-size:12px;color:#666;">
            📍 ${job.location}${job.salary ? `&nbsp;&nbsp; 💰 ${job.salary}` : ""}
          </div>

          <div style="padding:14px 24px;border-bottom:1px solid #1e1e1e;">
            <div style="display:flex;justify-content:space-between;font-size:11px;color:#555;margin-bottom:6px;">
              <span>MATCH SCORE</span><span style="color:#c8a96e;">${job.matchScore} / 100</span>
            </div>
            <div style="height:3px;background:#222;border-radius:2px;">
              <div style="height:3px;width:${scoreBarWidth};background:#c8a96e;border-radius:2px;"></div>
            </div>
          </div>

          <div style="padding:14px 24px;border-bottom:1px solid #1e1e1e;">
            <div style="font-size:10px;color:#444;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:6px;">Why it fits</div>
            <div style="font-size:13px;color:#999;line-height:1.6;">${job.whyGoodFit}</div>
          </div>

          <div style="padding:14px 24px;border-bottom:1px solid #1e1e1e;">
            <a href="${job.applyUrl}" style="background:#c8a96e;color:#0f0f0f;text-decoration:none;font-size:12px;font-weight:600;padding:8px 18px;border-radius:6px;display:inline-block;">View posting →</a>
          </div>

          ${
            resume || cover
              ? `<div style="margin:0 24px 20px;background:#111;border:1px solid #222;border-radius:8px;overflow:hidden;">
              ${
                resume
                  ? `<div style="padding:10px 16px;border-bottom:1px solid #1a1a1a;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.1em;">Tailored resume</div>
                <pre style="padding:14px 16px;font-size:11px;line-height:1.7;color:#666;font-family:monospace;white-space:pre-wrap;margin:0;">${resume}${resumeTruncated ? "..." : ""}</pre>`
                  : ""
              }
              ${
                cover
                  ? `<div style="padding:10px 16px;border-top:1px solid #1a1a1a;border-bottom:1px solid #1a1a1a;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:0.1em;">Cover letter</div>
                <pre style="padding:14px 16px;font-size:11px;line-height:1.7;color:#666;font-family:monospace;white-space:pre-wrap;margin:0;">${cover}${coverTruncated ? "..." : ""}</pre>`
                  : ""
              }
            </div>`
              : ""
          }

        </div>`;
    })
    .join("");

  return `
    <div style="max-width:640px;margin:0 auto;font-family:Arial,sans-serif;background:#0f0f0f;color:#e8e6e0;padding:32px 16px;">

      <div style="padding:32px 0 24px;border-bottom:1px solid #2a2a2a;margin-bottom:28px;">
        <div style="margin-bottom:12px;">
          <span style="font-size:11px;color:#666;letter-spacing:0.1em;text-transform:uppercase;">Job Scout Agent</span>
          <span style="font-size:11px;color:#444;float:right;">${today}</span>
        </div>
        <h1 style="font-size:26px;font-weight:600;color:#f0ede6;margin:0 0 8px;">${jobCount} new match${jobCount !== 1 ? "es" : ""} found today</h1>
        <p style="font-size:13px;color:#666;margin:0;">Your daily job digest is ready.</p>
      </div>

      <div style="background:#161616;border:1px solid #222;border-radius:10px;padding:16px 24px;margin-bottom:28px;">
        <table style="border-collapse:collapse;width:100%"><tr>
          <td style="padding:0 16px 0 0;">
            <div style="font-size:22px;font-weight:600;color:#f0ede6;">${jobCount}</div>
            <div style="font-size:10px;color:#444;text-transform:uppercase;letter-spacing:0.1em;">Matches</div>
          </td>
          <td style="padding:0 16px;border-left:1px solid #222;">
            <div style="font-size:22px;font-weight:600;color:#f0ede6;">${topScore}</div>
            <div style="font-size:10px;color:#444;text-transform:uppercase;letter-spacing:0.1em;">Top score</div>
          </td>
          <td style="padding:0 0 0 16px;border-left:1px solid #222;">
            <div style="font-size:22px;font-weight:600;color:#f0ede6;">${year}</div>
            <div style="font-size:10px;color:#444;text-transform:uppercase;letter-spacing:0.1em;">Year</div>
          </td>
        </tr></table>
      </div>

      ${jobCards}

      <div style="margin-top:32px;padding-top:20px;border-top:1px solid #1e1e1e;font-size:11px;color:#333;">
        Job Scout Agent · Running on Replit · Next run: tomorrow 7:00am
      </div>
    </div>
  `;
}
