#!/usr/bin/env python3
"""
Job Scout — "All Seeing Eye" multi-source job scraper.

Sources:
  Phase 1 - LinkedIn    : targeted searches, LinkedIn-exclusive jobs, 3 concurrent workers
  Phase 2 - Indeed (US) : broad national sweep, all role variants, 8 concurrent workers
  Phase 3 - Indeed (loc): per-location sweeps for each city in user's Settings, 6 workers
  Phase 4 - Glassdoor + ZipRecruiter : enabled when JOBSPY_PROXY env var (Replit Secret) is set

Proxy configuration:
  Set JOBSPY_PROXY in Replit Secrets (Settings → Secrets):
    Key  : JOBSPY_PROXY
    Value: http://user:password@host:port
  Residential or datacenter proxies both work.
  Credentials are NEVER written to logs or stdout.

Without proxy : LinkedIn + Indeed (~1,200+ unique jobs/run)
With proxy    : + Glassdoor + ZipRecruiter (~1,600+ unique jobs/run)

Usage:
  echo '{"target_roles":["AE","AM"],"locations":["Chicago, IL"]}' | python3 jobspy_scraper.py
Output: JSON array of job objects to stdout; progress/warnings to stderr
"""

import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from jobspy import scrape_jobs
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "python-jobspy"])
    from jobspy import scrape_jobs

import pandas as pd

# ── Proxy config — read from env (Replit Secret: JOBSPY_PROXY) ────────────────
# The Node.js server inherits Replit Secrets as env vars; child Python processes
# inherit from Node.js, so os.environ.get("JOBSPY_PROXY") works automatically.
_raw_proxy = os.environ.get("JOBSPY_PROXY", "").strip()

# Build both formats:
#  - PROXY_URL  : single string passed to JobSpy's proxies param
#  - PROXY_DICT : requests-style dict for any direct requests calls
PROXY_URL: str | None  = _raw_proxy if _raw_proxy else None
PROXY_DICT: dict | None = {"http": _raw_proxy, "https": _raw_proxy} if _raw_proxy else None


def _mask_proxy(url: str) -> str:
    """Return proxy URL with credentials replaced by *** for safe logging."""
    return re.sub(r"(https?://)([^@]+)@", r"\1***@", url)


def _proxy_status() -> str:
    if PROXY_URL:
        return f"configured ({_mask_proxy(PROXY_URL)})"
    return "not set — Glassdoor and ZipRecruiter will be skipped"


# ── Scraping config ───────────────────────────────────────────────────────────

RESULTS_INDEED       = 50   # Indeed: permissive, handles 50 reliably
RESULTS_LINKEDIN     = 50   # LinkedIn: 50 per term — rate limits handled by MAX_WORKERS_LINKEDIN=3
RESULTS_GLASSDOOR    = 25   # Glassdoor: proxy needed in cloud environments
RESULTS_ZIPRECRUITER = 25   # ZipRecruiter: Cloudflare-blocked without proxy

MAX_WORKERS_INDEED   = 8    # Indeed is very permissive
MAX_WORKERS_LINKEDIN = 3    # LinkedIn: low to avoid rate limits
MAX_WORKERS_GD_ZR    = 2    # Glassdoor/ZipRecruiter: conservative (proxy traffic)

HOURS_OLD = 168  # only jobs from the last 7 days

# Seniority prefixes applied to each detected base role
SENIORITY_PREFIXES = [
    "Senior", "Sr",
    "Commercial", "Enterprise", "Mid-Market",
    "Corporate", "Regional",
    "Named", "Strategic",
    "Territory", "Major Account",
    "Lead",
]

# Industry qualifiers — only applied to top 2 base roles to avoid term explosion
INDUSTRY_QUALIFIERS = [
    "SaaS",
    "B2B technology",
    "software",
    "cloud",
    "tech sales",
]

# Specialty searches — always run regardless of target roles
SPECIALTY_TERMS = [
    "Partner Manager SaaS",
    "Regional Sales Manager technology",
    "Client Executive enterprise software",
    "Enterprise Sales Representative B2B",
    "New Business Account Executive",
]

# Hard cap on Indeed national terms — keeps total run time under ~3 minutes
MAX_INDEED_TERMS = 50


# ── Search term generation ────────────────────────────────────────────────────

def build_terms(target_roles: list, user_locations: list = None, industries: list = None) -> dict:
    """
    Build search term sets for each source phase.

    Step 1 — Role × Sector (classic):
      seniority prefix × base role; industry qualifier × base role; specialty terms.

    Step 2 — Role × Location (new):
      Each exact target role combined with each user-saved location string.
      e.g. "Enterprise Account Executive Georgia", "Account Director Southeast"

    Step 3 — Role × Location × Sector top combos (new):
      top-3 roles × top-3 locations × top-3 industries for precise 3-keyword hits.
      e.g. "Enterprise AE Southeast data center"

    Returns:
      all_terms       : full set (capped at MAX_INDEED_TERMS) for Indeed national sweep
      linkedin_terms  : focused subset for LinkedIn (no industry qualifiers)
      location_terms  : high-signal subset for per-city Indeed sweeps
      role_x_loc_terms: role × location terms for targeted LinkedIn + Indeed passes
    """
    if user_locations is None:
        user_locations = []
    if industries is None:
        industries = []

    all_terms = set()

    # ── Step 1a: User's exact saved roles always included first ──────────────
    for role in target_roles:
        r = role.strip()
        if r:
            all_terms.add(r)

    # ── Step 1b: Detect base role families ────────────────────────────────────
    role_text = " ".join(target_roles).lower()
    base_roles = []
    role_map = [
        ("account executive",    "Account Executive"),
        ("account manager",      "Account Manager"),
        ("account rep",          "Account Representative"),
        ("sales executive",      "Sales Executive"),
        ("sales manager",        "Sales Manager"),
        ("sales rep",            "Sales Representative"),
        ("business development", "Business Development Representative"),
        ("customer success",     "Customer Success Manager"),
        ("solutions engineer",   "Solutions Engineer"),
        ("sales engineer",       "Sales Engineer"),
    ]
    for keyword, canonical in role_map:
        if keyword in role_text:
            base_roles.append(canonical)

    if not base_roles:
        base_roles = ["Account Executive", "Account Manager", "Sales Executive"]

    # ── Step 1c: Seniority prefix × base role ─────────────────────────────────
    for prefix in SENIORITY_PREFIXES:
        for role in base_roles:
            all_terms.add(f"{prefix} {role}")

    # ── Step 1d: Industry qualifier × top 2 base roles ────────────────────────
    # Use user-saved industries if available; fall back to hard-coded qualifiers
    industry_qualifiers = [i.strip() for i in industries if i.strip()] or INDUSTRY_QUALIFIERS
    for qual in industry_qualifiers:
        for role in base_roles[:2]:
            all_terms.add(f"{role} {qual}")

    # ── Step 1e: Specialty terms ───────────────────────────────────────────────
    all_terms.update(SPECIALTY_TERMS)

    # ── Step 2: Role × Location matrix ────────────────────────────────────────
    # Skip broad/vague location strings that won't help LinkedIn searches
    _skip_locs = {"united states", "us", "usa", "remote", ""}
    _specific_locs = [
        loc.strip() for loc in user_locations
        if loc.strip().lower() not in _skip_locs
    ]
    role_x_loc_terms: set = set()
    for role in target_roles:
        r = role.strip()
        if not r:
            continue
        for loc in _specific_locs:
            role_x_loc_terms.add(f"{r} {loc}")

    # Also add seniority × base role × location for the top 3 roles / top 3 locs
    top_roles = (target_roles or base_roles)[:3]
    top_locs  = _specific_locs[:3]
    for role in top_roles:
        for loc in top_locs:
            role_x_loc_terms.add(f"{role.strip()} {loc}")

    # ── Step 3: Role × Location × Industry top combos ─────────────────────────
    top_industries = [i.strip() for i in industries if i.strip()][:3] or INDUSTRY_QUALIFIERS[:3]
    role_x_loc_x_ind_terms: set = set()
    for role in (target_roles or base_roles)[:3]:
        r = role.strip()
        if not r:
            continue
        for loc in top_locs:
            for ind in top_industries:
                role_x_loc_x_ind_terms.add(f"{r} {loc} {ind}")

    # ── Apply hard cap on Step 1 terms ────────────────────────────────────────
    all_sorted = sorted(all_terms)
    if len(all_sorted) > MAX_INDEED_TERMS:
        priority = [t for t in all_sorted if t in target_roles]
        rest     = [t for t in all_sorted if t not in priority]
        all_sorted = (priority + rest)[:MAX_INDEED_TERMS]

    # ── LinkedIn subset: seniority variants only ───────────────────────────────
    linkedin_terms = sorted({
        t for t in all_sorted
        if not any(q in t for q in INDUSTRY_QUALIFIERS)
        and t not in SPECIALTY_TERMS
    })[:20]

    # ── Location subset: high-signal terms for per-city Indeed sweeps ─────────
    location_terms = sorted({
        t for t in all_sorted
        if any(p in t for p in ["Senior", "Enterprise", "Commercial", "Mid-Market", "Strategic", "Named"])
        or t in target_roles
    })[:15]

    # Merge role×loc and role×loc×ind into a single targeted set (capped at 200)
    targeted_terms = sorted(role_x_loc_terms | role_x_loc_x_ind_terms)[:200]

    return {
        "all_terms":      all_sorted,
        "linkedin_terms": linkedin_terms,
        "location_terms": location_terms,
        "targeted_terms": targeted_terms,
    }


# ── Per-source search functions ───────────────────────────────────────────────

def search_indeed(term: str, location: str, results: int = RESULTS_INDEED) -> pd.DataFrame:
    """Single Indeed search — full descriptions, no proxy needed."""
    try:
        df = scrape_jobs(
            site_name=["indeed"],
            search_term=term,
            location=location,
            results_wanted=results,
            hours_old=HOURS_OLD,
            description_format="markdown",
        )
        count = len(df) if df is not None and not df.empty else 0
        if count > 0:
            print(f'  [Indeed/{location[:20]}] "{term}" → {count}', file=sys.stderr)
        return df if df is not None else pd.DataFrame()
    except Exception as e:
        print(f'  [Indeed] "{term}" ✗ {type(e).__name__}: {str(e)[:80]}', file=sys.stderr)
        return pd.DataFrame()


def search_linkedin(term: str, location: str = "United States") -> pd.DataFrame:
    """
    Single LinkedIn search — no description fetch to stay within rate limits.
    LinkedIn-exclusive postings do not appear on Indeed, making this a critical
    supplementary source even without descriptions.
    """
    try:
        df = scrape_jobs(
            site_name=["linkedin"],
            search_term=term,
            location=location,
            results_wanted=RESULTS_LINKEDIN,
            hours_old=HOURS_OLD,
            linkedin_fetch_description=False,
        )
        count = len(df) if df is not None and not df.empty else 0
        if count > 0:
            print(f'  [LinkedIn] "{term}" → {count}', file=sys.stderr)
        return df if df is not None else pd.DataFrame()
    except Exception as e:
        print(f'  [LinkedIn] "{term}" ✗ {type(e).__name__}: {str(e)[:80]}', file=sys.stderr)
        return pd.DataFrame()


def search_glassdoor(term: str, location: str) -> pd.DataFrame:
    """
    Glassdoor search — requires JOBSPY_PROXY (Cloudflare-blocked without it).
    Credentials are not logged.
    """
    if not PROXY_URL:
        return pd.DataFrame()
    try:
        df = scrape_jobs(
            site_name=["glassdoor"],
            search_term=term,
            location=location,
            results_wanted=RESULTS_GLASSDOOR,
            hours_old=HOURS_OLD,
            description_format="markdown",
            proxies=PROXY_URL,          # JobSpy accepts str | list[str]
        )
        count = len(df) if df is not None and not df.empty else 0
        if count > 0:
            print(f'  [Glassdoor] "{term}" → {count}', file=sys.stderr)
        return df if df is not None else pd.DataFrame()
    except Exception as e:
        print(f'  [Glassdoor] "{term}" ✗ {type(e).__name__}: {str(e)[:80]}', file=sys.stderr)
        return pd.DataFrame()


def search_ziprecruiter(term: str, location: str = "United States") -> pd.DataFrame:
    """
    ZipRecruiter search — requires JOBSPY_PROXY (Cloudflare WAF 403 without it).
    Credentials are not logged.
    """
    if not PROXY_URL:
        return pd.DataFrame()
    try:
        df = scrape_jobs(
            site_name=["zip_recruiter"],
            search_term=term,
            location=location,
            results_wanted=RESULTS_ZIPRECRUITER,
            hours_old=HOURS_OLD,
            description_format="markdown",
            proxies=PROXY_URL,
        )
        count = len(df) if df is not None and not df.empty else 0
        if count > 0:
            print(f'  [ZipRecruiter] "{term}" → {count}', file=sys.stderr)
        return df if df is not None else pd.DataFrame()
    except Exception as e:
        print(f'  [ZipRecruiter] "{term}" ✗ {type(e).__name__}: {str(e)[:80]}', file=sys.stderr)
        return pd.DataFrame()


# ── Concurrency helper ────────────────────────────────────────────────────────

def run_concurrent(fn, args_list: list, max_workers: int, label: str) -> list:
    """Run fn(*args) for every args tuple in args_list concurrently."""
    frames = []
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {executor.submit(fn, *args): args for args in args_list}
        for future in as_completed(futures):
            try:
                df = future.result()
                if df is not None and not df.empty:
                    frames.append(df)
            except Exception as e:
                print(f"  [{label}] future error: {e}", file=sys.stderr)
    return frames


# ── Dedup helpers ─────────────────────────────────────────────────────────────

def dedup_df(df: pd.DataFrame) -> pd.DataFrame:
    """Dedup a single DataFrame by URL then by title+company."""
    if df is None or df.empty:
        return pd.DataFrame()
    if "job_url" in df.columns:
        df = df.drop_duplicates(subset=["job_url"], keep="first")
    if "title" in df.columns and "company" in df.columns:
        df["_key"] = df["title"].fillna("").str.lower().str.strip() + "||" + df["company"].fillna("").str.lower().str.strip()
        df = df.drop_duplicates(subset=["_key"], keep="first").drop(columns=["_key"])
    return df


def concat_and_dedup(frames: list, source_tag: str) -> pd.DataFrame:
    """Concat a list of DataFrames, tag source, then dedup."""
    if not frames:
        return pd.DataFrame()
    combined = pd.concat(frames, ignore_index=True)
    combined["_source"] = source_tag
    return dedup_df(combined)


def global_dedup(dfs: list) -> pd.DataFrame:
    """
    Cross-source dedup. When the same title+company appears on multiple sources,
    Indeed is preferred over LinkedIn because Indeed fetches full descriptions and
    provides more stable direct URLs. LinkedIn-exclusive jobs (not on Indeed) are
    still included — they just don't win the dedup contest when Indeed also has them.
    Priority: indeed > linkedin > glassdoor > ziprecruiter
    """
    source_priority = {"indeed": 0, "linkedin": 1, "glassdoor": 2, "ziprecruiter": 3}
    all_dfs = [df for df in dfs if df is not None and not df.empty]
    if not all_dfs:
        return pd.DataFrame()

    combined = pd.concat(all_dfs, ignore_index=True)

    # Sort so highest-priority source comes first for each deduplicated group
    if "_source" in combined.columns:
        combined["_sort"] = combined["_source"].map(lambda s: source_priority.get(s, 99))
        combined = combined.sort_values("_sort").drop(columns=["_sort"])

    if "job_url" in combined.columns:
        combined = combined.drop_duplicates(subset=["job_url"], keep="first")

    if "title" in combined.columns and "company" in combined.columns:
        combined["_key"] = combined["title"].fillna("").str.lower().str.strip() + "||" + combined["company"].fillna("").str.lower().str.strip()
        combined = combined.drop_duplicates(subset=["_key"], keep="first").drop(columns=["_key"])

    return combined


# ── Row → output dict ─────────────────────────────────────────────────────────

# Known ATS domains — if job_url_direct contains one of these, it is the canonical apply URL
ATS_DOMAINS = (
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
    "jobs.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
    "ashby.com/jobs",
    "myworkdayjobs.com",
    "jobs.jobvite.com",
    "hire.lever.co",
    "apply.workable.com",
    "bamboohr.com/jobs",
    "smartrecruiters.com",
    "recruiting.paylocity.com",
    "jobs.icims.com",
    "careers.jobscore.com",
)

# Regex to extract an ATS URL embedded anywhere in a job description
_ATS_URL_RE = re.compile(
    r'https?://(?:'
    + "|".join(re.escape(d).replace(r"\.", r"\.") for d in ATS_DOMAINS)
    + r')[^\s\)"\'<>]+',
    re.IGNORECASE,
)


def best_apply_url(row: pd.Series) -> str:
    """
    Return the best available apply URL for a job row, in priority order:
      1. job_url_direct if it resolves to a known ATS domain (most accurate)
      2. A direct ATS URL extracted from the job description
      3. job_url_direct (any direct URL, better than the aggregator link)
      4. job_url (aggregator fallback)
    """
    agg_url    = str(row.get("job_url",        "") or "").strip()
    direct_url = str(row.get("job_url_direct", "") or "").strip()
    if direct_url == "nan": direct_url = ""
    if agg_url    == "nan": agg_url    = ""

    # Priority 1: direct URL that is a known ATS domain
    if direct_url and any(d in direct_url for d in ATS_DOMAINS):
        return direct_url

    # Priority 2: ATS URL embedded in the description
    desc = str(row.get("description") or "")
    if desc and desc != "nan":
        m = _ATS_URL_RE.search(desc)
        if m:
            return m.group(0).rstrip(".,;)")

    # Priority 3: any direct URL (even aggregator-direct, better than /viewjob redirect)
    if direct_url and direct_url.startswith("http"):
        return direct_url

    # Priority 4: aggregator fallback
    return agg_url


# Patterns that indicate a generic careers-page listing, NOT a specific job posting.
# LinkedIn in particular sometimes returns these when it can't resolve a direct job URL.
_JUNK_TITLE_RE = re.compile(
    r'^(jobs|careers|openings|positions|opportunities|job opportunities|open roles|current openings)\s+at\b'
    r'|^(work|join us|life)\s+at\b'
    r'|^(jobs|careers|open roles|job openings|job opportunities)$'
    r'|\bjobs?\s+listing\b'
    r'|\bcareer\s+(portal|page|site|hub)\b',
    re.IGNORECASE,
)

# URLs that resolve to a generic careers home page rather than a specific job posting.
# We catch the most common patterns: /careers, /jobs, /job-board (with no further path).
_GENERIC_CAREERS_URL_RE = re.compile(
    r'(?:linkedin\.com/company/[^/]+/?$'           # linkedin company page (no /jobs/)
    r'|/careers/?(?:\?[^/]*)?$'                     # site.com/careers or /careers?...
    r'|/jobs/?(?:\?[^/]*)?$'                        # site.com/jobs or /jobs?...
    r'|/job-board/?(?:\?[^/]*)?$'                   # site.com/job-board
    r'|/about/careers/?$'                           # site.com/about/careers
    r'|greenhouse\.io/[^/]+/?$'                     # greenhouse company root, no /jobs/
    r'|lever\.co/[^/]+/?$)',                        # lever company root, no /apply/...
    re.IGNORECASE,
)


def _is_junk_listing(title: str, url: str) -> bool:
    """
    Return True if this row looks like a generic careers-page listing rather than
    a real, specific job posting. These are silently dropped to keep the pipeline clean.
    """
    t = title.strip()
    if not t or t.lower() in ("unknown", "nan", "none", ""):
        return True
    if _JUNK_TITLE_RE.search(t):
        return True
    # Extra guard: if the URL is a generic careers/jobs root page, drop it regardless of title
    if url and _GENERIC_CAREERS_URL_RE.search(url):
        return True
    return False


def row_to_job(row: pd.Series) -> dict | None:
    apply_url = best_apply_url(row)
    if not apply_url or apply_url == "nan":
        return None

    raw_title = str(row.get("title", "Unknown"))

    # Drop generic careers-page listings (e.g. "Jobs at Acme Corp" from LinkedIn)
    if _is_junk_listing(raw_title, apply_url):
        print(f'  [filter] Dropped junk listing: "{raw_title}" → {apply_url[:80]}', file=sys.stderr)
        return None

    # Location string
    parts = []
    loc_val = row.get("location")
    if pd.notna(loc_val) and str(loc_val).lower() not in ("nan", "none", ""):
        parts.append(str(loc_val))
    if pd.notna(row.get("is_remote")) and row["is_remote"]:
        if not parts or "remote" not in parts[0].lower():
            parts.insert(0, "Remote")
    job_location = ", ".join(parts) if parts else "Unknown"

    # Salary
    salary = None
    lo, hi = row.get("min_amount"), row.get("max_amount")
    if pd.notna(lo) and pd.notna(hi):
        salary = f"${int(lo):,} - ${int(hi):,}"
    elif pd.notna(lo):
        salary = f"${int(lo):,}+"
    elif pd.notna(hi):
        salary = f"Up to ${int(hi):,}"

    # Description (cap at 3000 chars to stay within Claude token budget)
    desc = row.get("description")
    desc_str = str(desc)[:3000] if pd.notna(desc) and desc else None

    # Date posted — use real date from source when available
    date_posted_val = row.get("date_posted")
    date_posted_str: str | None = None
    if date_posted_val is not None and pd.notna(date_posted_val):
        date_posted_str = str(date_posted_val)
        if date_posted_str in ("nan", "None", "NaT", ""):
            date_posted_str = None

    job: dict = {
        "title":    raw_title,
        "company":  str(row.get("company", "Unknown")),
        "location": job_location,
        "applyUrl": apply_url,
        "source":   str(row.get("_source", "jobspy")),
    }
    if salary:          job["salary"]      = salary
    if desc_str:        job["description"] = desc_str
    if date_posted_str: job["datePosted"]  = date_posted_str
    return job


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # ── Read criteria from Node.js via stdin ──────────────────────────────────
    criteria = {}
    try:
        raw = sys.stdin.read().strip()
        if raw:
            criteria = json.loads(raw)
    except Exception:
        pass

    target_roles:    list = criteria.get("target_roles") or []
    user_locations:  list = criteria.get("locations")    or []
    industries:      list = criteria.get("industries")   or []

    # ── Log startup info (NO proxy credentials in output) ────────────────────
    print(f"JobSpy: target_roles={target_roles}",   file=sys.stderr)
    print(f"JobSpy: locations={user_locations}",    file=sys.stderr)
    print(f"JobSpy: industries={industries}",       file=sys.stderr)
    print(f"JobSpy: proxy={_proxy_status()}",       file=sys.stderr)

    # Emit a structured status line so Node.js can surface it to the API
    proxy_configured = bool(PROXY_URL)
    print(f"PROXY_STATUS: {'configured' if proxy_configured else 'not_configured'}", file=sys.stderr)

    # ── Build search terms (dynamic from user settings) ───────────────────────
    terms           = build_terms(target_roles, user_locations, industries)
    all_terms       = terms["all_terms"]        # full set for Indeed national
    linkedin_terms  = terms["linkedin_terms"]   # focused subset for LinkedIn
    location_terms  = terms["location_terms"]   # focused subset for per-city sweeps
    targeted_terms  = terms["targeted_terms"]   # role × location (± industry) combos

    print(
        f"JobSpy search matrix: {len(all_terms)} sector terms | "
        f"{len(linkedin_terms)} LinkedIn terms | "
        f"{len(location_terms)} per-city terms | "
        f"{len(targeted_terms)} role\u00d7location targeted terms",
        file=sys.stderr,
    )

    source_dfs = []

    # ── Phase 1: LinkedIn (United States + Remote parallel) ───────────────────
    # Two passes: nationwide search + explicit "Remote" location search.
    # LinkedIn surfaces different listings for each — remote-flagged roles
    # appear prominently when location="Remote" is used directly.
    remote_linkedin_terms = linkedin_terms[:12]  # top 12 terms for remote pass
    total_li_raw = len(linkedin_terms) * RESULTS_LINKEDIN + len(remote_linkedin_terms) * RESULTS_LINKEDIN
    print(
        f"\nJobSpy [Phase 1/4]: LinkedIn — {len(linkedin_terms)} US terms + {len(remote_linkedin_terms)} Remote terms "
        f"× {RESULTS_LINKEDIN} = up to {total_li_raw} raw",
        file=sys.stderr,
    )
    li_us_frames = run_concurrent(
        search_linkedin,
        [(term, "United States") for term in linkedin_terms],
        MAX_WORKERS_LINKEDIN,
        "LinkedIn-US",
    )
    li_remote_frames = run_concurrent(
        search_linkedin,
        [(term, "Remote") for term in remote_linkedin_terms],
        MAX_WORKERS_LINKEDIN,
        "LinkedIn-Remote",
    )
    li_df = concat_and_dedup(li_us_frames + li_remote_frames, "linkedin")
    print(f"JobSpy [Phase 1/4]: LinkedIn → {len(li_df)} unique (US + Remote passes)", file=sys.stderr)
    source_dfs.append(li_df)

    # ── Phase 2: Indeed (national) ────────────────────────────────────────────
    print(
        f"\nJobSpy [Phase 2/4]: Indeed (US) — {len(all_terms)} terms "
        f"× {RESULTS_INDEED} = up to {len(all_terms)*RESULTS_INDEED} raw",
        file=sys.stderr,
    )
    indeed_us_frames = run_concurrent(
        search_indeed,
        [(term, "United States", RESULTS_INDEED) for term in all_terms],
        MAX_WORKERS_INDEED,
        "Indeed-US",
    )
    indeed_us_df = concat_and_dedup(indeed_us_frames, "indeed")
    print(f"JobSpy [Phase 2/4]: Indeed (US) → {len(indeed_us_df)} unique", file=sys.stderr)
    source_dfs.append(indeed_us_df)

    # ── Phase 3: Indeed per saved location ────────────────────────────────────
    specific_locations = [
        loc for loc in user_locations
        if loc.strip().lower() not in ("united states", "us", "usa", "remote", "")
    ]
    if specific_locations:
        for loc in specific_locations:
            print(
                f"\nJobSpy [Phase 3/4]: Indeed ({loc}) — {len(location_terms)} terms",
                file=sys.stderr,
            )
            loc_frames = run_concurrent(
                search_indeed,
                [(term, loc, RESULTS_INDEED) for term in location_terms],
                6,
                f"Indeed-{loc}",
            )
            loc_df = concat_and_dedup(loc_frames, "indeed")
            print(f"JobSpy [Phase 3/4]: Indeed ({loc}) → {len(loc_df)} unique", file=sys.stderr)
            source_dfs.append(loc_df)
    else:
        print(
            f"\nJobSpy [Phase 3/4]: Skipped (no specific cities in Settings → Locations)",
            file=sys.stderr,
        )

    # ── Phase 4: Glassdoor + ZipRecruiter (proxy-gated) ──────────────────────
    if PROXY_URL:
        gd_location = specific_locations[0] if specific_locations else "United States"
        gd_terms    = all_terms[:15]

        print(f"\nJobSpy [Phase 4/4]: Glassdoor — {len(gd_terms)} terms (proxy active)", file=sys.stderr)
        gd_frames = run_concurrent(
            search_glassdoor,
            [(term, gd_location) for term in gd_terms],
            MAX_WORKERS_GD_ZR,
            "Glassdoor",
        )
        gd_df = concat_and_dedup(gd_frames, "glassdoor")
        print(f"JobSpy [Phase 4/4]: Glassdoor → {len(gd_df)} unique", file=sys.stderr)
        source_dfs.append(gd_df)

        print(f"JobSpy [Phase 4/4]: ZipRecruiter — {len(gd_terms)} terms (proxy active)", file=sys.stderr)
        zr_frames = run_concurrent(
            search_ziprecruiter,
            [(term, "United States") for term in gd_terms],
            MAX_WORKERS_GD_ZR,
            "ZipRecruiter",
        )
        zr_df = concat_and_dedup(zr_frames, "ziprecruiter")
        print(f"JobSpy [Phase 4/4]: ZipRecruiter → {len(zr_df)} unique", file=sys.stderr)
        source_dfs.append(zr_df)
    else:
        print(
            f"\nJobSpy [Phase 4/4]: Glassdoor + ZipRecruiter SKIPPED — "
            f"JOBSPY_PROXY not set in Replit Secrets",
            file=sys.stderr,
        )

    # ── Phase 5: Targeted role × location (± industry) searches ──────────────
    # These are the dynamic combos built from the user's saved roles + locations.
    # Run on both LinkedIn and Indeed to maximise geo-targeted coverage.
    if targeted_terms:
        # LinkedIn targeted pass (top 30 terms, rate-limit conscious)
        li_targeted = targeted_terms[:30]
        print(
            f"\nJobSpy [Phase 5/5]: LinkedIn targeted (role×location) — {len(li_targeted)} terms",
            file=sys.stderr,
        )
        li_tgt_frames = run_concurrent(
            search_linkedin,
            [(term, "United States") for term in li_targeted],
            MAX_WORKERS_LINKEDIN,
            "LinkedIn-Targeted",
        )
        li_tgt_df = concat_and_dedup(li_tgt_frames, "linkedin")
        print(f"JobSpy [Phase 5/5]: LinkedIn targeted → {len(li_tgt_df)} unique", file=sys.stderr)
        source_dfs.append(li_tgt_df)

        # Indeed targeted pass — use specific location from each term (already embedded)
        # Run up to 50 targeted Indeed searches capped at 15 results each (faster)
        indeed_targeted = targeted_terms[:50]
        print(
            f"JobSpy [Phase 5/5]: Indeed targeted (role×location) — {len(indeed_targeted)} terms",
            file=sys.stderr,
        )
        indeed_tgt_frames = run_concurrent(
            search_indeed,
            [(term, "United States", 15) for term in indeed_targeted],
            MAX_WORKERS_INDEED,
            "Indeed-Targeted",
        )
        indeed_tgt_df = concat_and_dedup(indeed_tgt_frames, "indeed")
        print(f"JobSpy [Phase 5/5]: Indeed targeted → {len(indeed_tgt_df)} unique", file=sys.stderr)
        source_dfs.append(indeed_tgt_df)
    else:
        print(
            f"\nJobSpy [Phase 5/5]: Skipped — no locations saved in Settings",
            file=sys.stderr,
        )

    # ── Global cross-source dedup ─────────────────────────────────────────────
    total_raw = sum(len(df) for df in source_dfs if df is not None and not df.empty)
    final_df  = global_dedup(source_dfs)
    print(
        f"\nJobSpy: {total_raw} total across sources → {len(final_df)} unique after global dedup",
        file=sys.stderr,
    )

    # ── Build output ──────────────────────────────────────────────────────────
    jobs = []
    for _, row in final_df.iterrows():
        job = row_to_job(row)
        if job:
            jobs.append(job)

    from collections import Counter
    source_counts = Counter(j["source"] for j in jobs)
    print(f"JobSpy: source breakdown → {dict(source_counts)}", file=sys.stderr)
    print(f"JobSpy: outputting {len(jobs)} jobs", file=sys.stderr)

    # ── Coverage summary ──────────────────────────────────────────────────────
    _specific_locs_final = [
        loc for loc in user_locations
        if loc.strip().lower() not in ("united states", "us", "usa", "remote", "")
    ]
    print(f"\n{'='*60}", file=sys.stderr)
    print(f"JOBSPY COVERAGE SUMMARY", file=sys.stderr)
    print(f"{'='*60}", file=sys.stderr)
    print(f"  Roles searched ({len(target_roles)}): {', '.join(target_roles) or '(defaults)'}", file=sys.stderr)
    print(f"  Locations searched ({len(user_locations)}): {', '.join(user_locations) or '(national)'}", file=sys.stderr)
    print(f"  Industries used ({len(industries)}): {', '.join(industries) or '(qualifiers)'}", file=sys.stderr)
    print(f"  Sector terms built:   {len(all_terms)}", file=sys.stderr)
    print(f"  LinkedIn terms:       {len(linkedin_terms)}", file=sys.stderr)
    print(f"  Per-city terms:       {len(location_terms)} × {len(_specific_locs_final)} locations", file=sys.stderr)
    print(f"  Targeted terms:       {len(targeted_terms)} (role×location combos)", file=sys.stderr)
    print(f"  Raw results:          {total_raw}", file=sys.stderr)
    print(f"  After global dedup:   {len(final_df)}", file=sys.stderr)
    print(f"  Valid jobs output:    {len(jobs)}", file=sys.stderr)
    print(f"  Source breakdown:     {dict(source_counts)}", file=sys.stderr)
    print(f"{'='*60}\n", file=sys.stderr)

    # Emit a structured summary line so Node.js can parse it
    print(
        f"SCRAPE_SUMMARY: {json.dumps({'total': len(jobs), 'sources': dict(source_counts), 'proxy': proxy_configured})}",
        file=sys.stderr,
    )

    print(json.dumps(jobs))


if __name__ == "__main__":
    main()
