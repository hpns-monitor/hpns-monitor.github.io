# hpns-monitor.github.io

Static dashboard for the [gmcmap.com](https://gmcmap.com) Geiger and Radon
counters at Hunters Point Naval Shipyard:

- [Geiger — Param_ID 48050335359](https://gmcmap.com/historyData.asp?Param_ID=48050335359)
- [Radon  — Param_ID 18659894937](https://gmcmap.com/historyData.asp?Param_ID=18659894937)

## How it works

- A scheduled **GitHub Action** ([`.github/workflows/fetch.yml`](.github/workflows/fetch.yml))
  runs hourly. It executes [`scripts/fetch_gmcmap.py`](scripts/fetch_gmcmap.py),
  which scrapes gmcmap's HTML history table for each counter, parses it
  column-by-header, de-duplicates against the existing JSON, and commits
  updates into [`data/`](data/).
- The **static page** at <https://hpns-monitor.github.io/> loads those JSON
  files via `fetch()` (same origin → no CORS issue) and renders charts and a
  map entirely client-side. No server, no backend.

## Local development

```bash
# Run the fetcher once locally (optional — Action already does this)
pip install requests==2.32.3 beautifulsoup4==4.12.3 lxml==5.3.0
python scripts/fetch_gmcmap.py

# Serve the site
python -m http.server 8000
# → http://localhost:8000/
```

## Seeding from a local SQLite collector

If you've been running the companion Streamlit collector (which writes a
SQLite DB), you can pre-populate the JSON files for an immediate-history
launch:

```bash
python scripts/export_sqlite.py /path/to/gmcmap.db
```

## Files

```
.github/workflows/fetch.yml   # hourly cron + manual dispatch
scripts/fetch_gmcmap.py       # gmcmap → JSON
scripts/export_sqlite.py      # one-shot SQLite → JSON seed
data/<param_id>.json          # per-counter, append-only, deduplicated
index.html, app.js, style.css # dashboard
```

Data is from gmcmap.com (public). All times are displayed in Pacific
(PST/PDT auto).
