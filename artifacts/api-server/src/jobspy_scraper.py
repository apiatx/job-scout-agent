#!/usr/bin/env python3
"""
JobSpy scraper — searches LinkedIn and Indeed for enterprise sales roles
across hardware, infrastructure, AI, and industrial technology sectors.

Generates a full matrix of role titles x sector keywords (16 x 24 = 384 searches).
Runs in batches of 5 with 2-second delays to avoid rate limiting.
Deduplicates all results by job URL before output.

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

# ── Role titles ──────────────────────────────────────────────────────────────
ROLE_TITLES = [
    "Account Executive",
    "Enterprise Account Executive",
    "Senior Account Executive",
    "Named Account Executive",
    "Major Account Executive",
    "Strategic Account Executive",
    "Account Director",
    "Account Manager",
    "Enterprise Account Manager",
    "Senior Account Manager",
    "National Account Manager",
    "Partner Manager",
    "Channel Manager",
    "Channel Account Manager",
    "Regional Sales Manager",
    "Territory Sales Manager",
]

# ── Sector keywords ─────────────────────────────────────────────────────────
SECTOR_KEYWORDS = [
    "semiconductor",
    "data center",
    "networking",
    "storage",
    "artificial intelligence",
    "optical",
    "automation",
    "energy",
    "test and measurement",
    "GPU",
    "servers",
    "infrastructure",
    "edge computing",
    "robotics",
    "hardware",
    "IoT",
    "cloud infrastructure",
    "industrial",
    "photonics",
    "compute",
    "wireless",
    "fiber",
    "power systems",
    "sensors",
]

# ── Generate full search matrix ─────────────────────────────────────────────
SEARCHES = []
for role in ROLE_TITLES:
    for sector in SECTOR_KEYWORDS:
        SEARCHES.append({
            "site_name": ["linkedin", "indeed"],
            "search_term": f"{role} {sector}",
            "location": "United States",
            "results_wanted": 10,
            "is_remote": True,
        })

print(f"JobSpy: generated {len(SEARCHES)} searches ({len(ROLE_TITLES)} roles x {len(SECTOR_KEYWORDS)} sectors)", file=sys.stderr)


def run_search(search_params: dict) -> pd.DataFrame:
    """Run a single JobSpy search, returning results as a DataFrame."""
    term = search_params["search_term"]
    try:
        df = scrape_jobs(**search_params)
        if len(df) > 0:
            print(f"  ✓ \"{term}\" → {len(df)} results", file=sys.stderr)
        return df
    except Exception as e:
        print(f"  ✗ \"{term}\" → error: {e}", file=sys.stderr)
        return pd.DataFrame()


def main():
    all_frames = []
    batch_size = 5

    total_batches = (len(SEARCHES) + batch_size - 1) // batch_size
    for batch_idx in range(total_batches):
        start = batch_idx * batch_size
        end = min(start + batch_size, len(SEARCHES))
        batch = SEARCHES[start:end]

        print(f"\n── Batch {batch_idx + 1}/{total_batches} (searches {start + 1}-{end}/{len(SEARCHES)}) ──", file=sys.stderr)

        for search in batch:
            df = run_search(search)
            if not df.empty:
                all_frames.append(df)

        # Delay between batches (not after the last one)
        if batch_idx < total_batches - 1:
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

    print(f"JobSpy: outputting {len(jobs)} unique jobs as JSON", file=sys.stderr)
    print(json.dumps(jobs))


if __name__ == "__main__":
    main()
