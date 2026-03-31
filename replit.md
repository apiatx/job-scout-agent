# Job Scout Agent

## Overview

Job Scout Agent is a full-stack, automated job search tool designed to streamline the job application process. It aggregates job listings from various sources, including direct ATS portals (Greenhouse, Lever, Workday) and major job boards (LinkedIn, Indeed, Glassdoor) via JobSpy. The agent employs an advanced AI-powered Opportunity Scoring Engine using Anthropic Claude to evaluate job relevance and categorize them into actionable tiers: Top Targets, Fast Wins, Stretch Roles, and Probably Skip. Key capabilities include tailored resume and cover letter generation, in-depth company research, salary estimation, and daily email digests. The project aims to empower job seekers by automating discovery, assessment, and application preparation, significantly reducing manual effort and improving targeting.

## User Preferences

The user prefers detailed explanations for AI-generated insights, particularly for job scoring, tier assignments, and document tailoring. They require the ability to configure all search criteria, including target roles, industries, locations, keywords, salary expectations, and work types, ensuring that the job discovery and scoring align precisely with their career goals. They also want control over the AI models used for document generation and expect transparent status updates during long-running processes like scout runs and rescoring. The user wants the agent to assist in interview preparation by auto-generating battle cards when a job status is updated to "interviewing."

## System Architecture

The Job Scout Agent is built on a Node.js 24 runtime using `pnpm` for package management in a monorepo structure. The backend is an Express 5 server integrated with a PostgreSQL database.

**AI Integration:**
- **Anthropic Claude**: Used for job scoring, research, salary estimation (`claude-haiku-4-5`), and resume tailoring (`claude-sonnet-4-5`).
- **Gemini with Google Search**: Augments job discovery and resolves canonical URLs for aggregated and broken job links.

**Frontend:**
- A single-file, server-rendered HTML template embedded directly within `index.ts`, avoiding separate frontend build processes.

**Job Discovery Pipeline:**
- **Direct ATS Scrapers**: Custom scrapers for Greenhouse, Lever, and Workday APIs.
- **JobSpy Integration**: Python script `jobspy_scraper.py` handles scraping from Indeed, LinkedIn, and Glassdoor.
- **Filtering**:
    - **Company Safety Filter**: Claude AI screens out spam/fake companies from aggregated results.
    - **Title Filter**: Regex-based filtering of job titles using user-defined `target_roles`.
    - **Location Filter**: Validates job locations against user criteria, including `remote_strict` and territory-based roles.
- **AI Scoring**: Claude AI assesses jobs based on 7 sub-scores (role fit, company quality, location fit, hiring urgency, tailoring required, referral odds, real vs. fake), generating a match score (0-100) and AI risk assessment.
- **Tier Assignment**: `computeTier` function deterministically assigns jobs to "Top Target," "Fast Win," "Stretch Role," or "Probably Skip" based on match score, AI risk, sub-scores, and user-configurable tier settings (e.g., `top_target_score`, `stretch_companies`, `vertical_niches`).

**Job Recovery Engine (`link_validator.ts`):**
- A two-phase background system for resolving and enriching job data:
    - **Phase A (Fast, Parallel)**: Fetches missing job descriptions from Greenhouse/Lever public JSON APIs.
    - **Phase B (Slow, Sequential)**: Uses Gemini-grounded web search to find canonical ATS URLs for aggregator-sourced jobs and broken links.
- Ensures data integrity and surfaces resolved job details over original scraped data.

**Document Generation:**
- **Cover Letter Generator**: Two-step Claude AI process (company research + letter generation), supporting territory intelligence.
- **Resume Tailoring V2**: Three-step Claude AI process (ATS keyword research, gap analysis, tailored resume generation), also incorporating territory intelligence.
- **AI Model Selector**: User-configurable setting (`document_model`) to choose between `claude-opus-4-6` (default) and `claude-sonnet-4-6` for document generation.

**Pipeline and Interview Prep:**
- **"My Pipeline" Tab**: Kanban-style view of tracked jobs, grouped by status (interested, applied, interviewing, rejected), with `days_in_stage` and document badges.
- **Daily Action Card**: Claude Haiku generates prioritized daily action recommendations based on pipeline state.
- **Interview Prep Mode (Battle Card)**: Claude Haiku generates interview battle cards (company snapshot, top questions, pitch, watch-outs) triggered automatically when a job is marked "interviewing."

**Cross-Page Intelligence:**
- Clickable company names for filtering.
- Live job counts on the companies page.
- Sync banner from Career Intel to Positioning tab.

**Database Schema:**
- Managed using raw `pg` Pool with `CREATE TABLE IF NOT EXISTS` and `ALTER TABLE ADD COLUMN IF NOT EXISTS` for schema evolution.
- Key tables include `criteria`, `companies`, `jobs` (with extensive recovery and AI-related fields), `settings`, `saved_resumes`, `scout_runs`, `tailored_docs`, `tailored_resumes`, `cover_letters`, `research_briefs`, `job_research`, `salary_estimates`, `repvue_cache`, `gmail_tokens`, `career_intel`, `positioning_outputs`.

## External Dependencies

- **Anthropic Claude API**: For AI capabilities (scoring, research, document generation).
- **Google Gemini API**: For supplemental job discovery and URL grounding.
- **Google Search API**: Used in conjunction with Gemini for web search grounding.
- **PostgreSQL**: Database for all persistent data.
- **Greenhouse ATS API**: Direct integration for job scraping.
- **Lever ATS API**: Direct integration for job scraping.
- **Workday ATS API**: Direct integration for job scraping.
- **JobSpy (Python Library)**: Used for scraping jobs from Indeed, LinkedIn, and Glassdoor.
- **Gmail API**: For OAuth authentication and sending daily digest emails.