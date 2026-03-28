# Job Scout Agent

## Overview

A full-stack automated job search agent that discovers job listings across Greenhouse, Lever, and Workday career portals, plus JobSpy (Indeed). Jobs are scored with Claude AI using a multi-dimensional Opportunity Scoring Engine, classified into four tiers (Top Targets / Fast Wins / Stretch Roles / Probably Skip), and surfaced in a dashboard. Supports tailored resume/cover letter generation, company research, salary estimation, and daily digest emails via Gmail.

## Stack

- **Runtime**: Node.js 24 + tsx (dev server)
- **Package manager**: pnpm (monorepo)
- **Backend**: Express 5 + raw `pg` Pool (no Drizzle ORM in actual use)
- **Database**: PostgreSQL (Replit built-in)
- **AI**: Anthropic Claude claude-haiku-4-5 (via Replit AI Integrations)
- **Frontend**: Server-rendered HTML templates embedded in index.ts (single-file approach)
- **Job scraping**: Direct API calls to Greenhouse, Lever, Workday REST APIs; JobSpy Python script for Indeed

## Project Structure

```text
artifacts/api-server/
├── src/
│   ├── index.ts          # Main Express server + HTML frontend template (3400+ lines)
│   ├── agent.ts          # Claude AI scoring, tier logic, tailoring, research
│   ├── scraper.ts        # Greenhouse, Lever, Workday scrapers + JobSpy wrapper
│   ├── jobspy_scraper.py # Python: Indeed search via jobspy library
│   └── lib/
│       ├── salary.ts     # Claude-based salary estimation
│       └── gmail.ts      # Gmail OAuth + email sending
```

## Database Schema

- `criteria` — All user-configurable search settings
- `companies` — Target companies (greenhouse/lever/workday/plain types)
- `jobs` — Job matches with AI scores, tiers, sub_scores JSONB
- `settings` — Key/value store (resume text, active_resume_id, schedule, etc.)
- `saved_resumes` — Named resume versions (id, name, content, created_at)
- `scout_runs` — Run history
- `tailored_docs` — Generated resumes/cover letters per job
- `research_briefs` — Claude company research cache
- `salary_estimates` — Claude salary estimate cache
- `gmail_tokens` — Gmail OAuth tokens

## Criteria Schema Fields (All User-Configurable)

| Column | Type | Default | Purpose |
|--------|------|---------|---------|
| target_roles | TEXT[] | [...] | Job title patterns for scraper filter |
| industries | TEXT[] | [...] | Industry preferences |
| locations | TEXT[] | [...] | Target locations incl. "Remote" |
| must_have | TEXT[] | [...] | Required keywords |
| nice_to_have | TEXT[] | [...] | Preferred keywords |
| avoid | TEXT[] | [...] | Skip keywords |
| min_salary | INT | 130000 | Minimum salary |
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

## API Routes

- `GET/PUT /api/criteria` — All search criteria including new tier settings
- `GET/POST /api/companies`, `DELETE /api/companies/{id}`, `PUT /api/companies/{id}`
- `GET /api/jobs` — Returns all jobs with tier/score/status
- `PATCH /api/jobs/{id}/status`, `POST /api/jobs/{id}/generate-docs`
- `POST /api/jobs/rescore-all` — Re-score all unscored jobs with Claude (batches of 6)
- `POST /api/jobs/reclassify-local` — Re-classify all scored jobs using stored sub_scores (no AI calls)
- `POST /api/scout/run`, `GET /api/scout/status`
- `GET/PUT /api/settings/:key` — Key-value settings (resume text, etc.)
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
