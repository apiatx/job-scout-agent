# Job Scout Agent

## Overview

A full-stack automated job search agent. It fetches jobs from company career pages via public APIs (Greenhouse, Lever), scores them against your criteria using Claude AI, generates tailored resumes and cover letters, and optionally emails you a daily digest via Gmail.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **AI**: Anthropic Claude (via Replit AI Integrations — no user API key needed)
- **Frontend**: React + Vite + Tailwind CSS
- **Build**: esbuild (CJS bundle)

## Structure

```text
artifacts-monorepo/
├── artifacts/
│   ├── api-server/         # Express API server
│   └── job-scout/          # React + Vite frontend (serves at /)
├── lib/
│   ├── api-spec/           # OpenAPI spec + Orval codegen config
│   ├── api-client-react/   # Generated React Query hooks
│   ├── api-zod/            # Generated Zod schemas from OpenAPI
│   ├── db/                 # Drizzle ORM schema + DB connection
│   └── integrations-anthropic-ai/  # Anthropic AI integration
├── scripts/                # Utility scripts
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── tsconfig.json
└── package.json
```

## Database Schema

- `criteria` — Job search criteria (target roles, industries, salary, locations, keywords)
- `companies` — Target companies with ATS type (greenhouse/lever/workday/other) and ATS slug
- `jobs` — Job matches with scores, status, tailored docs
- `resume` — User's base resume text
- `scout_runs` — History of scout agent runs
- `gmail_tokens` — Gmail OAuth tokens for email sending

## API Routes

All routes are under `/api`:
- `GET/PUT /criteria` — Job search criteria
- `GET/POST /companies`, `DELETE /companies/{id}` — Target companies
- `GET /jobs`, `GET /jobs/{id}`, `PATCH /jobs/{id}/status`, `POST /jobs/{id}/generate-docs`
- `GET/PUT /resume`
- `POST /scout/run`, `GET /scout/status`
- `GET /gmail/status`, `GET /gmail/setup-url`, `GET /gmail/callback`, `POST /gmail/disconnect`, `POST /gmail/send-digest`

## Key Server Files

- `artifacts/api-server/src/lib/scraper.ts` — Greenhouse and Lever API fetchers
- `artifacts/api-server/src/lib/agent.ts` — Claude AI job scoring and doc generation
- `artifacts/api-server/src/lib/gmail.ts` — Gmail OAuth and email sending

## Frontend Pages

1. **Dashboard** — Stats overview, recent matches, scout history, "Run Scout Now" button
2. **Job Matches** — Filter/browse all jobs, update status, generate tailored docs
3. **Target Companies** — Add/remove companies with ATS type and slug
4. **Search Criteria** — Edit all job search preferences
5. **Base Resume** — Paste full resume text
6. **Gmail Integration** — OAuth connection, send digest manually

## Gmail Setup (User-Facing)

To enable email delivery, the user must:
1. Create a Google Cloud project at console.cloud.google.com
2. Enable the Gmail API
3. Create OAuth 2.0 credentials (Desktop App type) and download the JSON
4. Add `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` secrets in Replit
5. Set `GMAIL_REDIRECT_URI` to `https://<repl-domain>/api/gmail/callback`
6. Click "Connect Gmail" in the app and complete OAuth flow

## Environment Variables / Secrets Required

- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` — Auto-set by Replit AI integration
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` — Auto-set by Replit AI integration
- `DATABASE_URL` — Auto-set by Replit database
- `GMAIL_CLIENT_ID` — User must provide (from Google Cloud Console)
- `GMAIL_CLIENT_SECRET` — User must provide (from Google Cloud Console)
- `GMAIL_REDIRECT_URI` — User must set to `https://<domain>/api/gmail/callback`
