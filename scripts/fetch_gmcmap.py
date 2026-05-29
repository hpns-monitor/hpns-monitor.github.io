"""Hourly fetcher for the public hpns-monitor.github.io dashboard.

Walks gmcmap.com history pages for each configured counter, parses the HTML
table column-by-header (so detectors with different schemas — Geiger vs. Radon
— share one parser), de-duplicates against the existing JSON file, and writes
a compact array-of-arrays JSON to ``data/<param_id>.json``.

Designed to run from .github/workflows/fetch.yml with no extra services.
"""
from __future__ import annotations

import json
import logging
import re
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

COUNTERS = [
    {"param_id": "48050335359", "name": "hunters-point-naval-shipyard-geiger"},
    {"param_id": "18659894937", "name": "hunters-point-naval-shipyard-radon"},
]

BASE_URL = "https://gmcmap.com/historyData.asp"
# gmcmap blocks bot-like User-Agents; a normal Firefox UA works.
USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0"
PAGE_HARD_CAP = 5000
RETRY_DELAYS = (2, 8, 30)
INTER_PAGE_SLEEP = 0.5
REQUEST_TIMEOUT = 30
HEADER_TZ_RE = re.compile(r"GMT\s*([+-])\s*(\d{1,2})(?::(\d{2}))?", re.IGNORECASE)

# Fixed output schema — ``rows`` are arrays in this order. ``pci`` is NULL on
# detectors that do not report it.
FIELDS = ["t", "cpm", "acpm", "usv_h", "pci"]

# Map normalized HTML column header → (output-field-index, coercion-kind).
# Coercion-kind is "int" for cpm, "float" for the rest.
HEADER_FIELDS: dict[str, tuple[int, str]] = {
    "cpm":  (FIELDS.index("cpm"),   "int"),
    "acpm": (FIELDS.index("acpm"),  "float"),
    "usvh": (FIELDS.index("usv_h"), "float"),
    "pci":  (FIELDS.index("pci"),   "float"),
}

LAT_HEADERS = {"latitude"}
LON_HEADERS = {"longitude"}

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

log = logging.getLogger("fetch")


def _normalize_header(s: str) -> str:
    return "".join(c for c in s.lower() if c.isalnum())


def _coerce_int(s: str) -> int | None:
    s = s.strip()
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        try:
            return int(float(s))
        except ValueError:
            return None


def _coerce_float(s: str) -> float | None:
    s = s.strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def _parse_tz_offset(header_text: str) -> timezone:
    m = HEADER_TZ_RE.search(header_text)
    if not m:
        return timezone.utc
    sign, hh, mm = m.group(1), int(m.group(2)), int(m.group(3) or 0)
    delta = timedelta(hours=hh, minutes=mm)
    return timezone(delta if sign == "+" else -delta)


def fetch_page(session: requests.Session, param_id: str, curpage: int) -> str:
    params = {"Param_ID": param_id, "curpage": curpage}
    last_exc: Exception | None = None
    for attempt, delay in enumerate((0, *RETRY_DELAYS)):
        if delay:
            time.sleep(delay)
        try:
            resp = session.get(BASE_URL, params=params, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
            return resp.text
        except requests.RequestException as e:
            last_exc = e
            log.warning(
                "fetch failed (param_id=%s page=%d attempt=%d): %s",
                param_id, curpage, attempt + 1, e,
            )
    assert last_exc is not None
    raise last_exc


def parse_page(html: str) -> tuple[list[list], float | None, float | None]:
    """Parse one gmcmap history page.

    Returns ``(rows, lat, lon)``. Each row is ``[t_iso_utc, cpm, acpm, usv_h, pci]``
    matching ``FIELDS``. Missing columns are ``None``. ``lat``/``lon`` come from
    the first row's Latitude/Longitude cells, if present.
    """
    soup = BeautifulSoup(html, "lxml")
    container = soup.select_one("#content-table table")
    if container is None:
        return [], None, None
    headers = container.select("thead th")
    if not headers:
        return [], None, None
    tz = _parse_tz_offset(headers[0].get_text())

    # Column index → (output-field-index, coercion-kind) for measurement columns.
    field_at: dict[int, tuple[int, str]] = {}
    lat_idx: int | None = None
    lon_idx: int | None = None
    for idx, th in enumerate(headers[1:], start=1):
        norm = _normalize_header(th.get_text())
        if norm in HEADER_FIELDS:
            field_at[idx] = HEADER_FIELDS[norm]
        elif norm in LAT_HEADERS:
            lat_idx = idx
        elif norm in LON_HEADERS:
            lon_idx = idx

    rows: list[list] = []
    lat: float | None = None
    lon: float | None = None
    for tr in container.select("tbody tr"):
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if not cells:
            continue
        try:
            local_dt = datetime.strptime(cells[0], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            continue
        utc_dt = local_dt.replace(tzinfo=tz).astimezone(timezone.utc)
        row: list = [utc_dt.strftime("%Y-%m-%dT%H:%M:%SZ"), None, None, None, None]
        for idx, (field_idx, kind) in field_at.items():
            if idx < len(cells):
                raw = cells[idx]
                row[field_idx] = _coerce_int(raw) if kind == "int" else _coerce_float(raw)
        if lat is None and lat_idx is not None and lat_idx < len(cells):
            lat = _coerce_float(cells[lat_idx])
        if lon is None and lon_idx is not None and lon_idx < len(cells):
            lon = _coerce_float(cells[lon_idx])
        rows.append(row)
    return rows, lat, lon


def load_existing(path: Path) -> dict:
    if not path.exists():
        return {
            "param_id": "",
            "name": "",
            "lat": None,
            "lon": None,
            "has_pci": False,
            "fields": FIELDS,
            "rows": [],
        }
    with path.open() as f:
        return json.load(f)


def collect(session: requests.Session, counter: dict) -> dict:
    path = DATA_DIR / f"{counter['param_id']}.json"
    state = load_existing(path)
    state["param_id"] = counter["param_id"]
    state["name"] = counter["name"]
    state["fields"] = FIELDS

    existing_ts: set[str] = {r[0] for r in state["rows"]}
    pages_walked = 0
    new_rows: list[list] = []

    for curpage in range(1, PAGE_HARD_CAP + 1):
        html = fetch_page(session, counter["param_id"], curpage)
        rows, lat, lon = parse_page(html)
        pages_walked += 1
        if state["lat"] is None and lat is not None:
            state["lat"] = lat
        if state["lon"] is None and lon is not None:
            state["lon"] = lon
        if not rows:
            break
        page_new = [r for r in rows if r[0] not in existing_ts]
        if not page_new:
            break
        new_rows.extend(page_new)
        existing_ts.update(r[0] for r in page_new)
        time.sleep(INTER_PAGE_SLEEP)

    if new_rows:
        state["rows"].extend(new_rows)
        state["rows"].sort(key=lambda r: r[0])
        state["has_pci"] = any(r[FIELDS.index("pci")] is not None for r in state["rows"])
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("w") as f:
            json.dump(state, f, separators=(",", ":"))
        # newline at EOF for nicer diffs
        with path.open("a") as f:
            f.write("\n")

    log.info(
        "[%s] +%d new rows over %d page(s); total=%d",
        counter["name"], len(new_rows), pages_walked, len(state["rows"]),
    )
    return state


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        stream=sys.stdout,
    )
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT})

    any_failed = False
    for counter in COUNTERS:
        try:
            collect(session, counter)
        except Exception as e:
            any_failed = True
            log.exception("[%s] collection failed: %s", counter["name"], e)
    # Non-zero only if every counter failed; transient gmcmap blips shouldn't
    # mark the Action red if at least one counter updated.
    return 1 if any_failed and len(COUNTERS) == 1 else 0


if __name__ == "__main__":
    sys.exit(main())
