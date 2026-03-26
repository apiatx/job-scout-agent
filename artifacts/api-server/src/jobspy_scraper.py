#!/usr/bin/env python3
"""
Job Scout — "All Seeing Eye" multi-source job scraper.

Sources:
  Phase 1 - LinkedIn    : targeted searches, LinkedIn-exclusive jobs, 3 concurrent workers
  Phase 2 - Indeed (US) : broad national sweep, all role variants, 8 concurrent workers
  Phase 3 - Indeed (loc): per-location sweeps for each city in user's Settings, 6 workers
  Phase 4 - Glassdoor / ZipRecruiter (proxy-gated): enabled if JOBSPY_PROXIES env var set

Search strategies:
  - User's exact saved Target Roles always included (Settings → Target Roles)
  - Seniority variants: Senior, Sr, Commercial, Enterprise, Mid-Market, Strategic, Named, etc.
  - Industry qualifiers: SaaS, B2B, technology, software, cloud, tech sales
  - Specialty searches: partner mgmt, sales engineering, biz dev, customer success-adjacent AE
  - Location expansion: searches both nationally AND per saved location for in-market coverage

Dedup:
  - Stage 1: Within each source by job_url
  - Stage 2: Global cross-source by title+company (prefer LinkedIn, then Indeed, then others)
  - Stage 3: Final URL dedup across everything

Proxy support for Glassdoor / ZipRecruiter:
  Set JOBSPY_PROXIES env var: "http://user:pass@host:port,http://user2:pass2@host2:port2"
  Residential or datacenter proxies both work.

Usage:
  echo '{"target_roles":["AE","AM"],"locations":["Chicago, IL"]}' | python3 jobspy_scraper.py
Output: JSON array of job objects to stdout; progress to stderr
"""

import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

try:
    from jobspy import scrape_jobs
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "python-jobspy"])
    from jobspy import scrape_jobs

import pandas as pd

# ── Config ────────────────────────────────────────────────────────────────────

# How many results per search per source
RESULTS_INDEED      = 50    # Indeed handles 50+ reliably with no rate limiting
RESULTS_LINKEDIN    = 25    # LinkedIn: keep low to avoid rate limiting
RESULTS_GLASSDOOR   = 25    # Glassdoor: needs proxy in most environments
RESULTS_ZIPRECRUITER = 25   # ZipRecruiter: needs proxy (Cloudflare-blocked)

MAX_WORKERS_INDEED      = 8   # Indeed: very permissive, high parallelism OK
MAX_WORKERS_LINKEDIN    = 3   # LinkedIn: low to avoid rate limits
MAX_WORKERS_GLASSDOOR   = 2   # Glassdoor: very conservative (proxy needed)
MAX_WORKERS_ZIPREC      = 2   # ZipRecruiter: very conservative (proxy needed)

# Only show jobs posted in the last 7 days
HOURS_OLD = 168

# Seniority prefixes applied to each detected base role
# Kept to a focused 12 — avoids redundant variants like "Sr." vs "Sr"
SENIORITY_PREFIXES = [
    "Senior", "Sr",
    "Commercial", "Enterprise", "Mid-Market",
    "Corporate", "Regional",
    "Named", "Strategic",
    "Territory", "Major Account",
    "Lead",
]

# Industry qualifiers — only applied to the top 2 base roles to control term count
INDUSTRY_QUALIFIERS = [
    "SaaS",
    "B2B technology",
    "software",
    "cloud",
    "tech sales",
]

# Specialty searches — always run, role-agnostic
SPECIALTY_TERMS = [
    "Partner Manager SaaS",
    "Regional Sales Manager technology",
    "Client Executive enterprise software",
    "Enterprise Sales Representative B2B",
    "New Business Account Executive",
]

# Hard cap on Indeed national search terms — keeps run time under ~90s
MAX_INDEED_TERMS = 50

# Proxies for Glassdoor/ZipRecruiter (comma-separated in env var)
_proxy_env = os.environ.get("JOBSPY_PROXIES", "").strip()
PROXIES = [p.strip() for p in _proxy_env.split(",") if p.strip()] if _proxy_env else None


# ── Search term generation ────────────────────────────────────────────────────

def build_terms(target_roles: list) -> dict:
    """
    Returns a dict:
      all_terms    : all terms for Indeed national search
      linkedin_terms: focused subset for LinkedIn (top N most targeted)
      location_terms: focused subset for per-location Indeed searches
    """
    all_terms = set()

    # 1. User's exact saved roles (highest priority)
    for role in target_roles:
        r = role.strip()
        if r:
            all_terms.add(r)

    # 2. Detect base role families from user's saved roles
    role_text = " ".join(target_roles).lower()
    base_roles = []

    # Map common role keywords to canonical base roles
    role_map = [
        ("account executive",   "Account Executive"),
        ("account manager",     "Account Manager"),
        ("account rep",         "Account Representative"),
        ("sales executive",     "Sales Executive"),
        ("sales manager",       "Sales Manager"),
        ("sales rep",           "Sales Representative"),
        ("sales director",      "Sales Director"),
        ("business development","Business Development Representative"),
        ("bdr",                 "Business Development Representative"),
        ("sdr",                 "Sales Development Representative"),
        ("customer success",    "Customer Success Manager"),
        ("solutions engineer",  "Solutions Engineer"),
        ("sales engineer",      "Sales Engineer"),
    ]
    for keyword, canonical in role_map:
        if keyword in role_text:
            base_roles.append(canonical)

    # Default if nothing detected
    if not base_roles:
        base_roles = ["Account Executive", "Account Manager", "Sales Executive"]

    # 3. Seniority prefix × base role
    for prefix in SENIORITY_PREFIXES:
        for role in base_roles:
            all_terms.add(f"{prefix} {role}")

    # 4. Industry qualifier × top 2 base roles only (controls term explosion)
    key_roles = base_roles[:2]
    for qual in INDUSTRY_QUALIFIERS:
        for role in key_roles:
            all_terms.add(f"{role} {qual}")

    # 5. Specialty terms
    all_terms.update(SPECIALTY_TERMS)

    all_sorted = sorted(all_terms)

    # Hard cap for Indeed national to keep run time reasonable
    if len(all_sorted) > MAX_INDEED_TERMS:
        # Priority: user's exact roles first, then seniority variants, then rest
        priority = [t for t in all_sorted if t in target_roles]
        rest = [t for t in all_sorted if t not in priority]
        all_sorted = (priority + rest)[:MAX_INDEED_TERMS]

    # LinkedIn terms: seniority variants only (no industry qualifiers, no specialty)
    # Keep to ≤20 to avoid LinkedIn rate limits
    linkedin_terms = sorted({
        t for t in all_sorted
        if not any(q in t for q in INDUSTRY_QUALIFIERS)
        and t not in SPECIALTY_TERMS
    })[:20]

    # Location terms: most targeted 15 for per-city sweeps
    location_terms = sorted({
        t for t in all_sorted
        if any(p in t for p in ["Senior", "Enterprise", "Commercial", "Mid-Market", "Strategic", "Named"])
        or t in target_roles
    })[:15]

    return {
        "all_terms": all_sorted,
        "linkedin_terms": linkedin_terms,
        "location_terms": location_terms,
    }


# ── Single search ─────────────────────────────────────────────────────────────

def search_indeed(term: str, location: str, results: int = RESULTS_INDEED) -> pd.DataFrame:
    """Single Indeed search. Full descriptions included."""
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
        print(f'  [Indeed] "{term}" ✗ {type(e).__name__}: {str(e)[:60]}', file=sys.stderr)
        return pd.DataFrame()


def search_linkedin(term: str, location: str = "United States") -> pd.DataFrame:
    """Single LinkedIn search. No description fetch (too slow + rate-limited)."""
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
        print(f'  [LinkedIn] "{term}" ✗ {type(e).__name__}: {str(e)[:60]}', file=sys.stderr)
        return pd.DataFrame()


def search_glassdoor(term: str, location: str) -> pd.DataFrame:
    """Glassdoor search (requires proxy in most cloud environments)."""
    try:
        df = scrape_jobs(
            site_name=["glassdoor"],
            search_term=term,
            location=location,
            results_wanted=RESULTS_GLASSDOOR,
            hours_old=HOURS_OLD,
            description_format="markdown",
            proxies=PROXIES,
        )
        count = len(df) if df is not None and not df.empty else 0
        if count > 0:
            print(f'  [Glassdoor] "{term}" → {count}', file=sys.stderr)
        return df if df is not None else pd.DataFrame()
    except Exception as e:
        print(f'  [Glassdoor] "{term}" ✗ {type(e).__name__}: {str(e)[:60]}', file=sys.stderr)
        return pd.DataFrame()


def search_ziprecruiter(term: str, location: str = "United States") -> pd.DataFrame:
    """ZipRecruiter search (requires proxy in most cloud environments)."""
    try:
        df = scrape_jobs(
            site_name=["zip_recruiter"],
            search_term=term,
            location=location,
            results_wanted=RESULTS_ZIPRECRUITER,
            hours_old=HOURS_OLD,
            description_format="markdown",
            proxies=PROXIES,
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        )
        count = len(df) if df is not None and not df.empty else 0
        if count > 0:
            print(f'  [ZipRecruiter] "{term}" → {count}', file=sys.stderr)
        return df if df is not None else pd.DataFrame()
    except Exception as e:
        print(f'  [ZipRecruiter] "{term}" ✗ {type(e).__name__}: {str(e)[:60]}', file=sys.stderr)
        return pd.DataFrame()


# ── Batch runners ─────────────────────────────────────────────────────────────

def run_concurrent(fn, args_list: list, max_workers: int, label: str) -> list:
    """Run fn(*args) for each args tuple in args_list concurrently."""
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


# ── Dedup ─────────────────────────────────────────────────────────────────────

def dedup_frames(frames: list, source_tag: str) -> pd.DataFrame:
    """Combine and dedup a list of DataFrames from the same source."""
    if not frames:
        return pd.DataFrame()
    combined = pd.concat(frames, ignore_index=True)
    combined["_source"] = source_tag

    if "job_url" in combined.columns:
        combined = combined.drop_duplicates(subset=["job_url"], keep="first")

    if "title" in combined.columns and "company" in combined.columns:
        combined["_key"] = (
            combined["title"].fillna("").str.lower().str.strip() + "||" +
            combined["company"].fillna("").str.lower().str.strip()
        )
        combined = combined.drop_duplicates(subset=["_key"], keep="first")
        combined = combined.drop(columns=["_key"])

    return combined


def global_dedup(dfs: list) -> pd.DataFrame:
    """
    Cross-source dedup. Priority: linkedin > indeed > glassdoor > ziprecruiter.
    For the same title+company, we keep the LinkedIn version (has apply URL to LinkedIn posting).
    """
    source_priority = {"linkedin": 0, "indeed": 1, "glassdoor": 2, "ziprecruiter": 3}

    all_dfs = [df for df in dfs if df is not None and not df.empty]
    if not all_dfs:
        return pd.DataFrame()

    combined = pd.concat(all_dfs, ignore_index=True)

    # Sort so highest-priority source comes first for each duplicate group
    if "_source" in combined.columns:
        combined["_sort"] = combined["_source"].map(lambda s: source_priority.get(s, 99))
        combined = combined.sort_values("_sort").drop(columns=["_sort"])

    # Dedup by URL
    if "job_url" in combined.columns:
        combined = combined.drop_duplicates(subset=["job_url"], keep="first")

    # Dedup by title+company (cross-source)
    if "title" in combined.columns and "company" in combined.columns:
        combined["_key"] = (
            combined["title"].fillna("").str.lower().str.strip() + "||" +
            combined["company"].fillna("").str.lower().str.strip()
        )
        combined = combined.drop_duplicates(subset=["_key"], keep="first")
        combined = combined.drop(columns=["_key"])

    return combined


# ── Row → job dict ─────────────────────────────────────────────────────────────

def row_to_job(row: pd.Series) -> dict | None:
    apply_url = str(row.get("job_url", ""))
    if not apply_url or apply_url == "nan":
        return None

    # Location
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

    # Description (cap at 3000 chars to keep token usage reasonable)
    desc = row.get("description")
    desc_str = str(desc)[:3000] if pd.notna(desc) and desc else None

    source = str(row.get("_source", "jobspy"))

    job = {
        "title":    str(row.get("title",   "Unknown")),
        "company":  str(row.get("company", "Unknown")),
        "location": job_location,
        "applyUrl": apply_url,
        "source":   source,
    }
    if salary:   job["salary"]      = salary
    if desc_str: job["description"] = desc_str
    return job


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Read criteria from Node.js via stdin
    criteria = {}
    try:
        raw = sys.stdin.read().strip()
        if raw:
            criteria = json.loads(raw)
    except Exception:
        pass

    target_roles: list  = criteria.get("target_roles") or []
    user_locations: list = criteria.get("locations") or []

    print(f"JobSpy: target_roles={target_roles}", file=sys.stderr)
    print(f"JobSpy: user_locations={user_locations}", file=sys.stderr)
    print(f"JobSpy: proxies={'enabled' if PROXIES else 'none (Glassdoor/ZipRecruiter will be skipped)'}", file=sys.stderr)

    terms = build_terms(target_roles)
    all_terms      = terms["all_terms"]       # full set for Indeed national
    linkedin_terms = terms["linkedin_terms"]  # targeted subset for LinkedIn
    location_terms = terms["location_terms"]  # focused subset for per-city searches

    print(f"JobSpy: {len(all_terms)} Indeed terms | {len(linkedin_terms)} LinkedIn terms | {len(location_terms)} per-location terms", file=sys.stderr)

    source_dfs = []

    # ── Phase 1: LinkedIn ─────────────────────────────────────────────────────
    print(f"\nJobSpy [Phase 1/4]: LinkedIn — {len(linkedin_terms)} terms × {RESULTS_LINKEDIN} = up to {len(linkedin_terms)*RESULTS_LINKEDIN} raw", file=sys.stderr)
    li_args = [(term, "United States") for term in linkedin_terms]
    li_frames = run_concurrent(search_linkedin, li_args, MAX_WORKERS_LINKEDIN, "LinkedIn")
    li_df = dedup_frames(li_frames, "linkedin")
    print(f"JobSpy [Phase 1/4]: LinkedIn → {len(li_df)} unique", file=sys.stderr)
    source_dfs.append(li_df)

    # ── Phase 2: Indeed National ──────────────────────────────────────────────
    print(f"\nJobSpy [Phase 2/4]: Indeed (US) — {len(all_terms)} terms × {RESULTS_INDEED} = up to {len(all_terms)*RESULTS_INDEED} raw", file=sys.stderr)
    indeed_us_args = [(term, "United States", RESULTS_INDEED) for term in all_terms]
    indeed_us_frames = run_concurrent(search_indeed, indeed_us_args, MAX_WORKERS_INDEED, "Indeed-US")
    indeed_us_df = dedup_frames(indeed_us_frames, "indeed")
    print(f"JobSpy [Phase 2/4]: Indeed (US) → {len(indeed_us_df)} unique", file=sys.stderr)
    source_dfs.append(indeed_us_df)

    # ── Phase 3: Indeed per saved location ────────────────────────────────────
    # Skip if user has no locations or only has generic "United States"
    specific_locations = [
        loc for loc in user_locations
        if loc.strip().lower() not in ("united states", "us", "usa", "remote", "")
    ]
    if specific_locations:
        for loc in specific_locations:
            print(f"\nJobSpy [Phase 3/4]: Indeed ({loc}) — {len(location_terms)} terms × {RESULTS_INDEED}", file=sys.stderr)
            loc_args = [(term, loc, RESULTS_INDEED) for term in location_terms]
            loc_frames = run_concurrent(search_indeed, loc_args, 6, f"Indeed-{loc}")
            loc_df = dedup_frames(loc_frames, "indeed")
            print(f"JobSpy [Phase 3/4]: Indeed ({loc}) → {len(loc_df)} unique", file=sys.stderr)
            source_dfs.append(loc_df)
    else:
        print(f"\nJobSpy [Phase 3/4]: Skipped (no specific cities in Settings → Locations)", file=sys.stderr)

    # ── Phase 4: Glassdoor + ZipRecruiter (proxy-gated) ──────────────────────
    if PROXIES:
        # Glassdoor
        gd_terms = all_terms[:15]  # conservative subset
        gd_location = specific_locations[0] if specific_locations else "United States"
        print(f"\nJobSpy [Phase 4/4]: Glassdoor — {len(gd_terms)} terms (via proxy)", file=sys.stderr)
        gd_args = [(term, gd_location) for term in gd_terms]
        gd_frames = run_concurrent(search_glassdoor, gd_args, MAX_WORKERS_GLASSDOOR, "Glassdoor")
        gd_df = dedup_frames(gd_frames, "glassdoor")
        print(f"JobSpy [Phase 4/4]: Glassdoor → {len(gd_df)} unique", file=sys.stderr)
        source_dfs.append(gd_df)

        # ZipRecruiter
        zr_terms = all_terms[:15]
        print(f"JobSpy [Phase 4/4]: ZipRecruiter — {len(zr_terms)} terms (via proxy)", file=sys.stderr)
        zr_args = [(term, "United States") for term in zr_terms]
        zr_frames = run_concurrent(search_ziprecruiter, zr_args, MAX_WORKERS_ZIPREC, "ZipRecruiter")
        zr_df = dedup_frames(zr_frames, "ziprecruiter")
        print(f"JobSpy [Phase 4/4]: ZipRecruiter → {len(zr_df)} unique", file=sys.stderr)
        source_dfs.append(zr_df)
    else:
        print(f"\nJobSpy [Phase 4/4]: Glassdoor + ZipRecruiter skipped (set JOBSPY_PROXIES env var to enable)", file=sys.stderr)

    # ── Global cross-source dedup ─────────────────────────────────────────────
    total_raw = sum(len(df) for df in source_dfs if df is not None and not df.empty)
    final_df = global_dedup(source_dfs)
    print(f"\nJobSpy: {total_raw} total across sources → {len(final_df)} unique after global dedup", file=sys.stderr)

    # ── Build output ──────────────────────────────────────────────────────────
    jobs = []
    for _, row in final_df.iterrows():
        job = row_to_job(row)
        if job:
            jobs.append(job)

    # Source breakdown for logging
    from collections import Counter
    source_counts = Counter(j["source"] for j in jobs)
    print(f"JobSpy: source breakdown → {dict(source_counts)}", file=sys.stderr)
    print(f"JobSpy: outputting {len(jobs)} jobs", file=sys.stderr)
    print(json.dumps(jobs))


if __name__ == "__main__":
    main()
