#!/usr/bin/env python3
"""
JobSpy scraper — searches Indeed for sales roles using concurrent parallel searches.

Strategy:
- Indeed only: most reliable, no rate limiting, handles high volume cleanly
  (Glassdoor requires a specific location format; ZipRecruiter is Cloudflare-blocked)
- Concurrent searches via ThreadPoolExecutor — all terms run in parallel, not sequential
- Dynamic search terms built from the user's actual target roles saved in Settings
- 50 results per search term (Indeed handles this with no issues)
- Two-stage dedup: by job URL, then by title+company
- Criteria passed via stdin as JSON from the Node.js scout handler

Usage: echo '{"target_roles":["Account Executive"],"locations":[]}' | python3 jobspy_scraper.py
Output: JSON array of job objects to stdout
"""

import json
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed

# Auto-install jobspy if not present
try:
    from jobspy import scrape_jobs
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "python-jobspy"])
    from jobspy import scrape_jobs

import pandas as pd

# ── Configuration ─────────────────────────────────────────────────────────────

# How many results to pull per Indeed search (Indeed has no meaningful rate limiting)
RESULTS_PER_SEARCH = 50

# Max concurrent workers — 6 is safe for Indeed; too many and we may get throttled
MAX_WORKERS = 6

# Only surface jobs posted in the last 7 days
HOURS_OLD = 168

# Seniority prefixes applied to each base role the user cares about
SENIORITY_PREFIXES = [
    "Senior", "Sr", "Commercial", "Enterprise", "Mid-Market",
    "Corporate", "Regional", "Major", "Territory", "Named", "Strategic",
]

# Specialty searches always run (not tied to specific base roles)
SPECIALTY_TERMS = [
    "Partner Manager SaaS",
    "Regional Sales Manager technology",
    "Client Executive enterprise software",
    "Enterprise Sales Representative B2B",
]


# ── Search term generation ────────────────────────────────────────────────────

def build_search_terms(target_roles: list) -> list:
    """
    Build a focused set of Indeed search terms from the user's saved target roles.
    Adds seniority variants for each detected base role type.
    """
    terms = set()

    # Always include the user's exact saved roles
    for role in target_roles:
        role = role.strip()
        if role:
            terms.add(role)

    # Detect base role types from what the user saved
    role_text = " ".join(target_roles).lower()
    base_roles = []
    if "account executive" in role_text or not target_roles:
        base_roles.append("Account Executive")
    if "account manager" in role_text or not target_roles:
        base_roles.append("Account Manager")
    if "sales executive" in role_text:
        base_roles.append("Sales Executive")
    if "sales manager" in role_text:
        base_roles.append("Sales Manager")

    # Fall back if nothing detected
    if not base_roles:
        base_roles = ["Account Executive", "Account Manager"]

    # Generate seniority + base role combinations
    for prefix in SENIORITY_PREFIXES:
        for role in base_roles:
            terms.add(f"{prefix} {role}")

    # Add specialty searches
    terms.update(SPECIALTY_TERMS)

    result = sorted(terms)
    print(f"JobSpy: {len(result)} search terms generated from {len(target_roles)} target role(s)", file=sys.stderr)
    return result


# ── Single search ─────────────────────────────────────────────────────────────

def run_search(term: str, location: str) -> "pd.DataFrame":
    """Run a single Indeed search. Returns DataFrame (empty on error)."""
    try:
        df = scrape_jobs(
            site_name=["indeed"],
            search_term=term,
            location=location,
            results_wanted=RESULTS_PER_SEARCH,
            hours_old=HOURS_OLD,
            description_format="markdown",
        )
        count = len(df) if df is not None and not df.empty else 0
        if count > 0:
            print(f'  ✓ "{term}" → {count}', file=sys.stderr)
        return df if df is not None else pd.DataFrame()
    except Exception as e:
        print(f'  ✗ "{term}" → {type(e).__name__}: {str(e)[:80]}', file=sys.stderr)
        return pd.DataFrame()


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    # Read criteria passed from Node.js via stdin
    criteria = {}
    try:
        raw = sys.stdin.read().strip()
        if raw:
            criteria = json.loads(raw)
    except Exception:
        pass

    target_roles: list = criteria.get("target_roles") or []
    user_locations: list = criteria.get("locations") or []

    # Use the user's first saved location for geographic relevance, or search nationwide
    location = user_locations[0] if user_locations else "United States"
    print(f"JobSpy: location='{location}'", file=sys.stderr)

    search_terms = build_search_terms(target_roles)
    print(f"JobSpy: {len(search_terms)} terms × {RESULTS_PER_SEARCH} results each = up to {len(search_terms)*RESULTS_PER_SEARCH} raw | {MAX_WORKERS} concurrent workers", file=sys.stderr)

    # Run all searches concurrently
    all_frames = []
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        futures = {executor.submit(run_search, term, location): term for term in search_terms}
        for future in as_completed(futures):
            try:
                df = future.result()
                if df is not None and not df.empty:
                    all_frames.append(df)
            except Exception as e:
                print(f"  ✗ future error: {e}", file=sys.stderr)

    if not all_frames:
        print("JobSpy: no results from any search", file=sys.stderr)
        print("[]")
        return

    # Combine all results
    combined = pd.concat(all_frames, ignore_index=True)
    raw_count = len(combined)

    # Dedup by job URL
    if "job_url" in combined.columns:
        combined = combined.drop_duplicates(subset=["job_url"], keep="first")

    # Secondary dedup by title+company (catches same listing with different URLs)
    if "title" in combined.columns and "company" in combined.columns:
        combined["_key"] = (
            combined["title"].str.lower().str.strip() + "||" +
            combined["company"].fillna("").str.lower().str.strip()
        )
        combined = combined.drop_duplicates(subset=["_key"], keep="first")
        combined = combined.drop(columns=["_key"])

    print(f"JobSpy: {raw_count} raw → {len(combined)} unique after dedup", file=sys.stderr)

    # Build output
    jobs = []
    for _, row in combined.iterrows():
        # Location string
        parts = []
        loc_val = row.get("location")
        if pd.notna(loc_val) and str(loc_val).lower() not in ("nan", "none", ""):
            parts.append(str(loc_val))
        if pd.notna(row.get("is_remote")) and row["is_remote"]:
            if not parts or "remote" not in parts[0].lower():
                parts.insert(0, "Remote")
        job_location = ", ".join(parts) if parts else "Unknown"

        # Salary string
        salary = None
        lo, hi = row.get("min_amount"), row.get("max_amount")
        if pd.notna(lo) and pd.notna(hi):
            salary = f"${int(lo):,} - ${int(hi):,}"
        elif pd.notna(lo):
            salary = f"${int(lo):,}+"
        elif pd.notna(hi):
            salary = f"Up to ${int(hi):,}"

        apply_url = str(row.get("job_url", ""))
        if not apply_url or apply_url == "nan":
            continue

        desc = row.get("description")
        desc_str = str(desc)[:3000] if pd.notna(desc) and desc else None

        job = {
            "title": str(row.get("title", "Unknown")),
            "company": str(row.get("company", "Unknown")),
            "location": job_location,
            "applyUrl": apply_url,
            "source": "indeed",
        }
        if salary:
            job["salary"] = salary
        if desc_str:
            job["description"] = desc_str
        jobs.append(job)

    print(f"JobSpy: outputting {len(jobs)} jobs", file=sys.stderr)
    print(json.dumps(jobs))


if __name__ == "__main__":
    main()
