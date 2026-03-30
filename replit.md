# Job Scout Agent

## Overview

A full-stack automated job search agent that discovers job listings via a **hybrid pipeline**: Greenhouse, Lever, and Workday career portals + JobSpy (LinkedIn/Indeed/Glassdoor) + **Gemini with Google Search grounding** (supplemental discovery). Jobs are scored with Claude AI using a multi-dimensional Opportunity Scoring Engine, classified into four tiers (Top Targets / Fast Wins / Stretch Roles / Probably Skip), and surfaced in a dashboard. Supports tailored resume/cover letter generation, company research, salary estimation, and daily digest emails via Gmail.

## Stack

- **Runtime**: Node.js 24 + tsx (dev server)
- **Package manager**: pnpm (monorepo)
- **Backend**: Express 5 + raw `pg` Pool (no Drizzle ORM in actual use)
- **Database**: PostgreSQL (Replit built-in)
- **AI**: Anthropic Claude — `claude-haiku-4-5` (scoring/research/salary), `claude-sonnet-4-5` (resume tailoring)
- **Frontend**: Server-rendered HTML templates embedded in index.ts (single-file approach)
- **Job scraping**: Direct API calls to Greenhouse, Lever, Workday REST APIs; JobSpy Python script for Indeed/LinkedIn/Glassdoor
- **URL health check**: Background HEAD-request checker marks `url_ok` on all job links; broken links surface as warnings in UI
- **Job Recovery Engine** (`link_validator.ts`): Two-phase background system that replaces bad scraped data in the DB record itself (not suppression — recovery):
  - **Phase A (fast, parallel)**: Fetches real job descriptions from Greenhouse/Lever public JSON APIs for ATS-direct jobs with missing/short descriptions. Runs 10 concurrent fetches. No Gemini needed, no rate limits. Uses official `boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}?content=true` API (NOT the HTML URL with `.json`). Also handles company career pages embedding Greenhouse IDs via `?gh_jid=` parameter (e.g. Databricks) by joining with `companies.ats_slug`. Excludes `validation_status='failed'` jobs to prevent infinite retry loops. Writes fetched description to BOTH `description` AND `resolved_description` columns.
  - **Phase B (slow, sequential)**: Uses Gemini grounded web search to find canonical ATS URLs for aggregator-sourced (LinkedIn/Indeed/etc.) and broken-link jobs. Capped at 15 jobs/run with 1.5s between calls.
  - **Display fields**: `enrichJobRecord()` returns `display_title`, `display_description`, `display_url`, `display_location` — prefer resolved/recovered data over original scraped data, with guards against listing-page content (e.g. "Current openings at X").
  - **Validation status badge**: Cards show "✔ Recovered" (teal), "✔ Verified" (green), "✔ Direct" (faint green) based on `validation_status` field.

## Project Structure

```text
artifacts/api-server/
├── src/
│   ├── index.ts             # Main Express server + HTML frontend template (4700+ lines)
│   ├── agent.ts             # Claude AI scoring, tier logic, tailoring, research
│   ├── scraper.ts           # Greenhouse, Lever, Workday scrapers + JobSpy wrapper
│   ├── jobspy_scraper.py    # Python: LinkedIn/Indeed/Glassdoor via jobspy
│   ├── gemini_discovery.ts  # Gemini + Google Search grounding discovery module
│   ├── link_validator.ts    # Canonical URL resolution: source trust scoring, confidence computation, Gemini resolver
│   └── lib/
│       ├── salary.ts        # Claude-based salary estimation
│       └── gmail.ts         # Gmail OAuth + email sending
```

## Database Schema

- `criteria` — All user-configurable search settings
- `companies` — Target companies (greenhouse/lever/workday/plain types)
- `jobs` — Job matches with AI scores, tiers, sub_scores JSONB, `user_action`, `user_action_at`, `interview_prep_json`, `interview_prep_at`
  - Recovery columns: `canonical_url`, `canonical_source`, `original_url`, `original_title`, `original_description`, `link_confidence`, `was_resolved_by_gemini`, `validation_notes`, `validation_status` ('validated'|'recovered'|'suspicious'|'failed'|'pending'), `page_type`, `resolved_title`, `resolved_description`, `resolved_location`, `resolved_metadata_json`, `metadata_last_verified_at`
- `settings` — Key/value store (resume text `key='resume'`, schedule, etc.)
- `saved_resumes` — Named resume versions (id, name, content, created_at)
- `scout_runs` — Run history (+ `current_stage TEXT`, `jobs_in_pipeline INT` for live progress tracking)
- `tailored_docs` — Generated resumes/cover letters per job
- `tailored_resumes` — ATS-tailored resumes with gap analysis per job
- `cover_letters` — Generated cover letters per job
- `research_briefs` — Claude company research cache
- `job_research` — Per-job research results (used by interview prep)
- `salary_estimates` — Claude salary estimate cache
- `repvue_cache` — RepVue sales culture data cache
- `gmail_tokens` — Gmail OAuth tokens
- `career_intel` — AI career intelligence cache (JSONB)
- `positioning_outputs` — Career positioning generated outputs (JSONB)

## Criteria Schema Fields (All User-Configurable)

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| target_roles | TEXT[] | [...] | Job title patterns for scraper filter |
| industries | TEXT[] | [...] | Industry preferences |
| locations | TEXT[] | [...] | Target locations incl. "Remote" |
| must_have | TEXT[] | [...] | Required keywords |
| nice_to_have | TEXT[] | [...] | Preferred keywords |
| avoid | TEXT[] | [...] | Skip keywords |
| min_salary | INT | 130000 | Minimum base salary (hard gate) |
| min_ote | INT | null | Minimum OTE/total comp (hard gate) |
| work_type | TEXT | 'any' | any/remote/office/hybrid |
| remote_strict | BOOLEAN | true | Reject remote-in-territory jobs |
| your_name | TEXT | '' | For resume tailoring |
| your_email | TEXT | '' | For daily digest |
| experience_level | TEXT | 'senior' | junior/mid/senior/enterprise/director |
| stretch_companies | TEXT[] | [] | Companies always classified as Stretch |
| vertical_niches | TEXT[] | [] | Title keywords → above-level signal |
| top_target_score | INT | 65 | Min score for Top Target tier |
| fast_win_score | INT | 55 | Min score for Fast Win tier |
| stretch_score | INT | 55 | Min score for Stretch Role tier |

## Job Discovery Pipeline

### Stage 2a: Direct ATS scrapers (Greenhouse, Lever, Workday)
- **Greenhouse**: HTTP GET to `boards-api.greenhouse.io/v1/boards/{slug}/jobs` — 10 companies
- **Lever**: HTTP GET to `api.lever.co/v0/postings/{slug}` — 1 company
- **Workday**: POST to `https://{subdomain}/wday/cxs/{company}/{slug}/jobs` with `searchText` — 22/27 companies work (Honeywell, Cummins, Seagate, TE Connectivity, Generac fail with 422/404)
  - Searches 9 role terms per company: "account executive", "account manager", "sales manager", "regional sales", "territory sales", "partner manager", "sales executive", "client executive", "client manager"
  - Breaks early on 422/404/403

### Stage 2b: JobSpy (Indeed via Python)
- Runs `jobspy_scraper.py` — 15 targeted Indeed searches for broad role titles
- Catches jobs from companies not directly scraped (plain type + extras)

### Stage 2c: Company safety filter
- Claude filters out fake/spam companies from JobSpy results

### Stage 3: Title filter
- `buildTitleFilter` builds regex from target_roles (full phrases + individual keywords ≥3 chars)
- Filler words excluded: senior, junior, lead, staff, principal, vice, president, head

### Stage 4: Location filter
- `checkJobLocation` validates each job's location against user criteria
- `isRemoteInTerritory` detects "Remote, Chicago" style territory roles
- International country codes (UK, GB, EU, etc.) detected and rejected in SE territory check

### Stage 5: Claude scoring (batches of 6)
- 7 sub-scores (roleFit, companyQuality, locationFit, hiringUrgency, tailoringRequired, referralOdds, realVsFake)
- AI risk assessment (LOW/MEDIUM/HIGH)
- Match score 0-100
- Why good fit narrative

### Stage 6: Tier assignment (computeTier)
- Uses user-configurable TierSettings from criteria DB
- Stretch Companies list → always Stretch even for accessible roles
- Vertical Niches list → title keywords that push role above user's level
- Score thresholds from top_target_score, fast_win_score, stretch_score

## Opportunity Scoring Engine (computeTier)

```
computeTier(matchScore, aiRisk, subScores, title, company, location, tierSettings?)
```

Logic:
1. **Hard skips**: HIGH ai_risk, realVsFake < 5, matchScore < 50 → Probably Skip
2. **Stretch**: (isAboveLevel || isHyperCompetitive) && score >= stretchScore → Stretch Role
3. **Top Target**: isAccessibleRole && score >= topTargetScore && companyQuality >= 7 && roleFit >= 6 → Top Target
4. **Fast Win**: Commercial/MM/Corporate/Major && score >= fastWinScore → Fast Win
5. **Fast Win fallback**: isAccessibleRole && score >= (fastWinScore + 5) → Fast Win
6. **Stretch fallback**: score >= stretchScore → Stretch Role
7. Default → Probably Skip

**isAboveLevel signals**: strategic, director/RVP/VP, principal, named, Sr+Enterprise combined, vertical niche keywords

**isAccessibleRole signals**: standard enterprise (no above-level qualifiers), commercial, mid-market, corporate, regional/territory, partner, major AE, senior-only AE, generic AE/AM/sales titles

## Location Logic (module-level in index.ts)

- `STATE_ABBREV`: full state → abbrev mapping
- `US_STATE_ABBREVS`: set of 2-letter state codes
- `VAGUE_DIRECTIONALS`: {'south', 'north', 'east', 'west'} — excluded from location pattern (prevent "South Salt Lake" false matches)
- `INTL_COUNTRY_CODES`: regex for UK/GB/EU/CA etc. → detected as international, fails SE territory check
- `buildLocationAllowPattern`: builds regex from user locations
- `checkJobLocation(loc, userLocations, remoteStrict)`: canonical location check
- `isRemoteInTerritory(loc)`: detects "Remote, City" style territory roles
- `reclassifyJobsLocally()`: re-applies location check + computeTier to all scored jobs

## Document Generation Features

### Cover Letter Generator
- Endpoint: `POST /api/jobs/:id/cover-letter` (`?force=true` to bypass cache)
- 2-step pipeline: (1) Claude web-search research → specific company facts, (2) Claude letter generation grounded in research
- Caches 3 most recent per job in `cover_letters` table
- Uses `document_model` setting (default `claude-opus-4-6`); temperature varied on regenerate for different output

### Resume Tailoring V2
- Endpoint: `POST /api/jobs/:id/tailor-resume` (`?force=true` to bypass cache)
- 3-step pipeline: (1) ATS keyword research with web search, (2) gap analysis (no web), (3) tailored resume generation
- Caches in `tailored_resumes` table; response includes `ats_research`, `gap_analysis`, `resume_text`
- Uses `document_model` setting (default `claude-opus-4-6`)

### AI Model Selector
- Setting key: `document_model` — `claude-opus-4-6` (default) or `claude-sonnet-4-6`
- Saved via `GET/PUT /api/settings/document_model`
- Both endpoints read this at request time — no restart required
- Frontend: "AI Model for Documents" dropdown on Settings page; model badge shown in both modals after generation

### Territory Intelligence
- Auto-detects geographic/vertical territories from job title + description (Southeast, Northeast, SLED, Federal, Mid-Atlantic, Pacific Northwest, Midwest, Bay Area, Texas, Florida, etc.)
- If detected: runs `analyzeTerritoryContext()` — an additional Claude web-search call using `claude-haiku-4-5` (non-fatal, parallel to existing research)
- `TerritoryContext` fields: `territoryDetected`, `whyThisTerritory`, `keyIndustries`, `majorProspects`, `recentWins`, `competitiveLandscape`, `marketMoment`, `candidateAdvantage`
- Cover letter: territory block injected into generation prompt — opening paragraph references territory strategic importance, candidate experience in that geography called out explicitly
- Resume tailoring: territory block injected into step 3 — summary and bullets reframed to surface geographic/industry relevance
- If no territory detected: step skipped entirely, zero performance impact

## Pipeline + Interview Prep + Cross-Page Intelligence (latest)

### My Pipeline Tab
- New sidebar tab "My Pipeline" (sub-tab under Jobs/Saved Jobs)
- `GET /api/pipeline` — returns tracked jobs grouped by status (interested/applied/interviewing/rejected), each with `days_in_stage` and `has_docs` count
- Kanban-style view with 4 columns; shows days in stage, fit score, docs badge, prep badge
- **Daily Action Card**: `POST /api/pipeline/daily-actions` — Claude Haiku generates 3 prioritized action recommendations based on current pipeline state
- Auto-refreshes pipeline when `markJobAction` is called while Pipeline tab is active

### Interview Prep Mode (Battle Card)
- `POST /api/jobs/:id/interview-prep` — generates Claude Haiku battle card: company snapshot, top 5 questions + answer starters, your pitch, watch-outs
- `GET /api/jobs/:id/interview-prep` — retrieve cached battle card
- DB columns: `interview_prep_json TEXT`, `interview_prep_at TIMESTAMPTZ` on `jobs` table
- **Auto-triggers**: When user marks a job as "interviewing" via `markJobAction`, interview prep is auto-generated as fire-and-forget
- **"🎯 View Prep" / "Gen Prep" button** appears on Pipeline cards in the Interviewing column
- Rendered in a slide-up modal (`prep-modal-overlay`)

### Cross-Page Intelligence
- **Company names on job cards are clickable** — calls `filterToCompany(name)` to filter the jobs grid to that company
- **Companies page shows live job counts** — "N open roles →" button computed from `_allJobs` in-memory, clicking it filters Jobs tab
- **Career Intel → Positioning sync banner** — "Sync to Positioning" button in Career Intel panel takes user directly to Positioning tab
- `clearCompanyFilter()` removes company filter; count display restored via `updateJobsCountDisplay()`

## API Routes

- `GET/PUT /api/criteria` — All search criteria including new tier settings
- `GET/POST /api/companies`, `DELETE /api/companies/{id}`, `PUT /api/companies/{id}`
- `GET /api/jobs` — Returns all jobs with tier/score/status
- `PATCH /api/jobs/{id}/status`, `POST /api/jobs/{id}/generate-docs`
- `GET /api/industry-leaders` — Return cached Industry Leaders result (stale flag if >7 days)
- `POST /api/industry-leaders/refresh` — Regenerate with Claude (12 sectors, top 5-10 companies each, sales-led filter)
- `POST /api/jobs/rescore-all` — Re-score all unscored jobs with Claude (batches of 6)
- `POST /api/jobs/rescore-all?force=true` — Re-score ALL jobs that have descriptions (≥50 chars), even if already scored. Use after description enrichment or criteria changes. Returns `{started, count}`. UI button: "↺ Force Rescore" with confirm dialog.
- `POST /api/jobs/reclassify-local` — Re-classify all scored jobs using stored sub_scores (no AI calls)
- `POST /api/scout/run`, `GET /api/scout/status`, `GET /api/scout/auto-status`
- `POST /api/jobs/{id}/outreach` — Claude-generated LinkedIn DM (connection request + follow-up DM)
- **Auto-scheduler**: On startup, schedules a check every 15 min; auto-runs if last completed run > 20 hours ago. No user action required after first setup.
- `GET/PUT /api/settings/:key` — Key-value settings (resume text, document_model, etc.)
- `POST /api/jobs/{id}/cover-letter` — Cover letter generation with research + territory intelligence
- `POST /api/jobs/{id}/tailor-resume` — Resume tailoring V2 with ATS analysis + territory intelligence
- `GET /api/gmail/status`, `GET /api/gmail/setup-url`, `GET /api/gmail/callback`, `POST /api/gmail/disconnect`, `POST /api/gmail/send-digest`

## Gmail Setup

1. Create Google Cloud project, enable Gmail API
2. Create OAuth 2.0 credentials (Desktop App), add `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` to Replit secrets
3. Click "Connect Gmail" in the app to complete OAuth flow

## Environment Variables

- `AI_INTEGRATIONS_ANTHROPIC_BASE_URL` — Auto-set by Replit AI integration
- `AI_INTEGRATIONS_ANTHROPIC_API_KEY` — Auto-set by Replit AI integration
- `DATABASE_URL` — Auto-set by Replit database
- `GMAIL_CLIENT_ID` — User must provide
- `GMAIL_CLIENT_SECRET` — User must provide

## Key Design Decisions

- **No Drizzle ORM**: Uses raw `pg` Pool throughout; schema managed via `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN IF NOT EXISTS` in `initDb()`
- **Single-file frontend**: HTML is a giant template string in index.ts — no separate React build
- **computeTier is deterministic**: Claude scoring influences sub_scores + matchScore; the tier itself is computed deterministically by computeTier() (not by Claude) so it can be re-run without AI calls
- **TierSettings interface**: All tier classification parameters (stretch companies, vertical niches, score thresholds) come from user criteria DB — nothing hardcoded in agent.ts
- **reclassifyJobsLocally on startup**: Every server start re-applies location + tier logic to all existing jobs using stored sub_scores (no Claude calls)
