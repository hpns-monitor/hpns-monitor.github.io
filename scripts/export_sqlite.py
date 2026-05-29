"""One-shot exporter: read a local gmcmap collector SQLite DB and emit the
``data/<param_id>.json`` files used by the static dashboard.

Usage:
    python scripts/export_sqlite.py /path/to/gmcmap.db

The output schema matches ``scripts/fetch_gmcmap.py`` so subsequent Action runs
can append into the same files.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

FIELDS = ["t", "cpm", "acpm", "usv_h", "pci"]
DATA_DIR = Path(__file__).resolve().parent.parent / "data"


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("db_path", type=Path)
    args = p.parse_args()

    if not args.db_path.exists():
        print(f"DB not found: {args.db_path}", file=sys.stderr)
        return 2

    conn = sqlite3.connect(f"file:{args.db_path}?mode=ro", uri=True)
    counters = conn.execute(
        "SELECT param_id, COALESCE(MIN(name), param_id) AS name, "
        "MIN(latitude), MIN(longitude) "
        "FROM readings GROUP BY param_id"
    ).fetchall()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for param_id, name, lat, lon in counters:
        rows = conn.execute(
            "SELECT timestamp_utc, cpm, acpm, usv_h, pci "
            "FROM readings WHERE param_id = ? ORDER BY timestamp_utc",
            (param_id,),
        ).fetchall()
        out = {
            "param_id": param_id,
            "name": name,
            "lat": lat,
            "lon": lon,
            "has_pci": any(r[4] is not None for r in rows),
            "fields": FIELDS,
            "rows": [list(r) for r in rows],
        }
        path = DATA_DIR / f"{param_id}.json"
        with path.open("w") as f:
            json.dump(out, f, separators=(",", ":"))
            f.write("\n")
        print(f"wrote {path} ({len(rows)} rows, has_pci={out['has_pci']})")

    return 0


if __name__ == "__main__":
    sys.exit(main())
