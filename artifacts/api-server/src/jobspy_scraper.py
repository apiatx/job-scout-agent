#!/usr/bin/env python3
"""
JobSpy scraper — searches LinkedIn, Indeed, and Glassdoor simultaneously
for enterprise hardware/infrastructure sales roles.

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

SEARCHES = [
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Enterprise Account Executive semiconductor",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Enterprise Account Executive data center hardware",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Enterprise Account Executive networking hardware",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Enterprise Account Executive storage hardware",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Enterprise Account Executive AI infrastructure",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Strategic Account Executive NVIDIA Dell HPE Cisco",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Account Executive industrial automation Rockwell Honeywell Emerson",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Sales Director energy technology Vertiv Bloom Fluence",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Account Executive semiconductor Marvell Broadcom Micron Entegris",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
    {
        "site_name": ["linkedin", "indeed", "glassdoor"],
        "search_term": "Regional Sales Manager optical networking Ciena Infinera Lumentum Coherent",
        "location": "United States",
        "results_wanted": 50,
        "is_remote": True,
    },
]


def run_search(search_params: dict) -> pd.DataFrame:
    """Run a single JobSpy search, returning results as a DataFrame."""
    term = search_params["search_term"]
    try:
        print(f"JobSpy: searching \"{term}\"...", file=sys.stderr)
        df = scrape_jobs(**search_params)
        print(f"JobSpy: found {len(df)} results for \"{term}\"", file=sys.stderr)
        return df
    except Exception as e:
        print(f"JobSpy: error searching \"{term}\": {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)
        return pd.DataFrame()


def main():
    all_frames = []

    for i, search in enumerate(SEARCHES):
        print(f"\n── Search {i+1}/{len(SEARCHES)} ──", file=sys.stderr)
        df = run_search(search)
        if not df.empty:
            all_frames.append(df)
        # Small delay between searches to avoid rate limiting
        if i < len(SEARCHES) - 1:
            time.sleep(2)

    if not all_frames:
        print("JobSpy: no results from any search", file=sys.stderr)
        print("[]")
        return

    # Combine and deduplicate
    combined = pd.concat(all_frames, ignore_index=True)
    print(f"\nJobSpy: {len(combined)} total results before dedup", file=sys.stderr)

    # Deduplicate by job_url
    if "job_url" in combined.columns:
        combined = combined.drop_duplicates(subset=["job_url"], keep="first")
    print(f"JobSpy: {len(combined)} unique results after dedup", file=sys.stderr)

    # Convert to our JSON format
    jobs = []
    for _, row in combined.iterrows():
        # Build location string
        location_parts = []
        if pd.notna(row.get("location")):
            location_parts.append(str(row["location"]))
        if pd.notna(row.get("is_remote")) and row["is_remote"]:
            if not location_parts or "remote" not in location_parts[0].lower():
                location_parts.insert(0, "Remote")
        location = ", ".join(location_parts) if location_parts else "Unknown"

        # Build salary string
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
            "source": str(row.get("site", "jobspy")),
        }
        if salary:
            job["salary"] = salary

        # Skip entries with no URL
        if not job["applyUrl"] or job["applyUrl"] == "nan":
            continue

        jobs.append(job)

    print(f"JobSpy: outputting {len(jobs)} jobs as JSON", file=sys.stderr)
    print(json.dumps(jobs))


if __name__ == "__main__":
    main()
