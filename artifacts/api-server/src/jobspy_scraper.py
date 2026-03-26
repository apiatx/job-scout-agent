#!/usr/bin/env python3
"""
JobSpy scraper — searches Indeed for enterprise sales roles.

Runs targeted role-title searches on Indeed to find jobs not covered by
the direct Greenhouse/Lever/Workday scrapers.

Usage: python3 jobspy_scraper.py
Output: JSON array of job objects to stdout
"""

import json
import sys
import time
import traceback

# Auto-install jobspy if not present
try:
    from jobspy import scrape_jobs
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "-q", "python-jobspy"])
    from jobspy import scrape_jobs

import pandas as pd

# ── Role title searches (broad terms that catch the widest net) ───────────────
ROLE_SEARCHES = [
    "Enterprise Account Executive",
    "Commercial Account Executive",
    "Mid-Market Account Executive",
    "Corporate Account Executive",
    "Regional Account Executive",
    "Major Account Executive",
    "Partner Manager",
    "Regional Sales Manager",
    "Territory Sales Manager",
    "Senior Account Executive",
    "Account Executive hardware",
    "Account Executive infrastructure",
    "Account Executive semiconductor",
    "Account Executive networking",
    "Account Manager enterprise technology",
]

print(f"JobSpy: {len(ROLE_SEARCHES)} targeted Indeed searches", file=sys.stderr)


def run_search(term: str) -> "pd.DataFrame":
    try:
        df = scrape_jobs(
            site_name=["indeed"],
            search_term=term,
            location="United States",
            results_wanted=15,
            is_remote=True,
            hours_old=168,  # last 7 days
        )
        if len(df) > 0:
            print(f'  ✓ "{term}" → {len(df)} results', file=sys.stderr)
        else:
            print(f'  - "{term}" → 0 results', file=sys.stderr)
        return df
    except Exception as e:
        print(f'  ✗ "{term}" → error: {e}', file=sys.stderr)
        return pd.DataFrame()


def main():
    all_frames = []

    for i, term in enumerate(ROLE_SEARCHES):
        df = run_search(term)
        if not df.empty:
            all_frames.append(df)
        # Short delay to avoid rate limiting — not needed after last search
        if i < len(ROLE_SEARCHES) - 1:
            time.sleep(1.5)

    if not all_frames:
        print("JobSpy: no results from any search", file=sys.stderr)
        print("[]")
        return

    # Combine and deduplicate
    combined = pd.concat(all_frames, ignore_index=True)
    print(f"\nJobSpy: {len(combined)} total results before dedup", file=sys.stderr)

    if "job_url" in combined.columns:
        combined = combined.drop_duplicates(subset=["job_url"], keep="first")
    print(f"JobSpy: {len(combined)} unique results after dedup", file=sys.stderr)

    jobs = []
    for _, row in combined.iterrows():
        location_parts = []
        if pd.notna(row.get("location")):
            location_parts.append(str(row["location"]))
        if pd.notna(row.get("is_remote")) and row["is_remote"]:
            if not location_parts or "remote" not in location_parts[0].lower():
                location_parts.insert(0, "Remote")
        location = ", ".join(location_parts) if location_parts else "Unknown"

        salary = None
        min_amount = row.get("min_amount")
        max_amount = row.get("max_amount")
        if pd.notna(min_amount) and pd.notna(max_amount):
            salary = f"${int(min_amount):,} - ${int(max_amount):,}"
        elif pd.notna(min_amount):
            salary = f"${int(min_amount):,}+"
        elif pd.notna(max_amount):
            salary = f"Up to ${int(max_amount):,}"

        job = {
            "title": str(row.get("title", "Unknown")),
            "company": str(row.get("company", "Unknown")),
            "location": location,
            "applyUrl": str(row.get("job_url", "")),
            "description": str(row.get("description", ""))[:2000] if pd.notna(row.get("description")) else None,
            "source": "indeed",
        }
        if salary:
            job["salary"] = salary

        if not job["applyUrl"] or job["applyUrl"] == "nan":
            continue

        jobs.append(job)

    print(f"JobSpy: outputting {len(jobs)} unique jobs as JSON", file=sys.stderr)
    print(json.dumps(jobs))


if __name__ == "__main__":
    main()
