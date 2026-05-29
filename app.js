"use strict";

// ---------- CONFIG --------------------------------------------------------

const COUNTERS = [
  { param_id: "48050335359" },  // geiger — default (first)
  { param_id: "18659894937" },  // radon
];
const TIME_ZONE = "America/Los_Angeles";
const REFRESH_MS = 5 * 60 * 1000;          // re-fetch JSON every 5 minutes
const ROLLING_WINDOW_MS = 3600e3;          // 1h rolling-mean window (fixed)

// CPM color bands — matches the legend the user provided.
const CPM_BANDS = [
  { upper: 50,        label: "0–50 CPM",     css: "#4cd964" },
  { upper: 100,       label: "50–100 CPM",   css: "#c5e673" },
  { upper: 200,       label: "100–200 CPM",  css: "#f4c36c" },
  { upper: Infinity,  label: "Over 200 CPM", css: "#ff6347" },
];

const RANGE_MS = {
  hour:  3600e3,
  day:   86400e3,
  week:  7 * 86400e3,
  month: 30 * 86400e3,
  year:  365 * 86400e3,
  all:   Infinity,
};

// Bucket candidates for downsampling, in seconds.
const BUCKET_CANDIDATES_S = [60, 5*60, 15*60, 60*60, 6*60*60, 24*60*60, 7*24*60*60];
const TARGET_POINTS_PER_COUNTER = 400;

// ---------- STATE ---------------------------------------------------------

const STATE = {
  active:       localStorage.getItem("active")       || COUNTERS[0].param_id,
  range:        localStorage.getItem("range")        || "week",
  customStart:  localStorage.getItem("customStart")  || "",
  customEnd:    localStorage.getItem("customEnd")    || "",
};

const DATA = {};   // param_id → {param_id, name, lat, lon, has_pci, fields, rows}

// ---------- HELPERS -------------------------------------------------------

function fieldIdx(d, name) { return d.fields.indexOf(name); }

function cpmColor(cpm) {
  if (cpm == null) return "#888";
  for (const b of CPM_BANDS) if (cpm < b.upper) return b.css;
  return CPM_BANDS[CPM_BANDS.length - 1].css;
}

function tzAbbrev() {
  const parts = new Intl.DateTimeFormat("en-US",
    { timeZone: TIME_ZONE, timeZoneName: "short" }).formatToParts(new Date());
  return (parts.find(p => p.type === "timeZoneName") || {}).value || "PT";
}

function fmtDateTime(d) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(d);
}

// How many minutes west of UTC the target timezone is at the given instant.
// E.g. PDT (UTC-7) → +420, PST (UTC-8) → +480, UTC → 0.
function targetTzOffsetMin(utcDate) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(utcDate);
  const g = t => +parts.find(p => p.type === t).value;
  const targetWallAsUtc = Date.UTC(
    g("year"), g("month") - 1, g("day"),
    g("hour") % 24, g("minute"), g("second"),
  );
  return (utcDate.getTime() - targetWallAsUtc) / 60_000;
}

// Return a Date whose browser-local rendering matches the time in TIME_ZONE,
// independent of where the viewer actually is. Plotly displays Date objects in
// the browser's local zone — by shifting the value by (browser_offset −
// target_offset) we make the browser's own subtraction land on the target.
//
// PDT viewer: shift = 0  → pass raw UTC, browser shows PDT.
// UTC viewer: shift = −7h → date moves back 7h, browser (UTC) shows PDT.
function toDisplayDate(utcDate) {
  const shiftMin = utcDate.getTimezoneOffset() - targetTzOffsetMin(utcDate);
  return new Date(utcDate.getTime() + shiftMin * 60_000);
}

function activeData() { return DATA[STATE.active]; }

function rangeBounds() {
  const now = Date.now();
  if (STATE.range === "custom") {
    const start = STATE.customStart ? Date.parse(STATE.customStart + "T00:00:00") : 0;
    const end   = STATE.customEnd   ? Date.parse(STATE.customEnd   + "T23:59:59") : now;
    return { startMs: start, endMs: end };
  }
  const span = RANGE_MS[STATE.range];
  if (span === Infinity) return { startMs: -Infinity, endMs: Infinity };
  return { startMs: now - span, endMs: now };
}

function filterRows(rows) {
  const { startMs, endMs } = rangeBounds();
  if (startMs === -Infinity && endMs === Infinity) return rows;
  return rows.filter(r => {
    const t = Date.parse(r[0]);
    return t >= startMs && t <= endMs;
  });
}

// Time-based rolling mean over an array of {t, v}. Returns an array of means
// (or null for windows with no data) at the same indices.
function rollingMean(times, values, windowMs) {
  const out = new Array(values.length);
  let sum = 0, count = 0, left = 0;
  for (let right = 0; right < values.length; right++) {
    const v = values[right];
    if (v != null) { sum += v; count++; }
    while (left <= right && (times[right] - times[left]) > windowMs) {
      const lv = values[left];
      if (lv != null) { sum -= lv; count--; }
      left++;
    }
    out[right] = count > 0 ? sum / count : null;
  }
  return out;
}

function pickBucketSeconds(spanSec) {
  const target = Math.max(spanSec / TARGET_POINTS_PER_COUNTER, 60);
  for (const c of BUCKET_CANDIDATES_S) if (c >= target) return c;
  return BUCKET_CANDIDATES_S[BUCKET_CANDIDATES_S.length - 1];
}

function downsampleSeries(times, values, bucketMs) {
  if (times.length === 0) return { times, values };
  const buckets = new Map();
  for (let i = 0; i < times.length; i++) {
    if (values[i] == null) continue;
    const key = Math.floor(times[i].getTime() / bucketMs);
    if (!buckets.has(key)) buckets.set(key, { sum: 0, count: 0 });
    const b = buckets.get(key);
    b.sum += values[i]; b.count++;
  }
  const keys = [...buckets.keys()].sort((a, b) => a - b);
  return {
    times:  keys.map(k => new Date((k + 0.5) * bucketMs)),
    values: keys.map(k => buckets.get(k).sum / buckets.get(k).count),
  };
}

function fmtBucket(bucketSec) {
  if (bucketSec >= 86400) return Math.round(bucketSec / 86400) + "d";
  if (bucketSec >= 3600)  return Math.round(bucketSec / 3600)  + "h";
  return Math.round(bucketSec / 60) + "m";
}

// ---------- DATA LOADING --------------------------------------------------

async function loadAllData() {
  const fetchOne = async (c) => {
    const r = await fetch(`data/${c.param_id}.json?t=${Date.now()}`,
      { cache: "no-cache" });
    if (!r.ok) throw new Error(`fetch ${c.param_id} failed: HTTP ${r.status}`);
    return r.json();
  };
  const results = await Promise.all(COUNTERS.map(fetchOne));
  results.forEach(d => { DATA[d.param_id] = d; });
}

// ---------- RENDERING -----------------------------------------------------

const PLOTLY_LAYOUT_BASE = {
  height: 320,
  margin: { l: 50, r: 14, t: 36, b: 36 },
  hovermode: "x unified",
  showlegend: false,
  font: { size: 12 },
  xaxis: { title: "", showgrid: true, gridcolor: "#eee", fixedrange: true },
  yaxis: { showgrid: true, gridcolor: "#eee", fixedrange: true },
  // Disable click-and-drag chart panning so finger swipes on mobile pass
  // through to the page scroller instead of being captured by Plotly.
  dragmode: false,
};
const PLOTLY_CONFIG = {
  displaylogo: false,
  responsive: true,
  scrollZoom: false,
  doubleClick: false,
  showTips: false,
  staticPlot: false,
  displayModeBar: false,
};

// Reference thresholds rendered as dashed horizontal lines on each chart.
// CPM bands match the on-map color legend. uSv/h ladder is the conventional
// safety escalation. pCi/L thresholds are EPA / WHO action levels.
const THRESHOLDS = {
  "chart-cpm": [
    { y: 50,  color: "#c5e673", label: "50 CPM" },
    { y: 100, color: "#f4c36c", label: "100 CPM" },
    { y: 200, color: "#ff6347", label: "200 CPM (critical)" },
  ],
  "chart-cpm-rolling": [
    { y: 50,  color: "#c5e673", label: "50" },
    { y: 100, color: "#f4c36c", label: "100" },
    { y: 200, color: "#ff6347", label: "200 (critical)" },
  ],
  "chart-usv": [
    { y: 0.30, color: "#f4c36c", label: "0.3 µSv/h (elevated)" },
    { y: 1.0,  color: "#ff6347", label: "1.0 µSv/h (high)" },
  ],
  "chart-pci": [
    { y: 2.7, color: "#c5e673", label: "2.7 pCi/L (WHO reference)" },
    { y: 4.0, color: "#ff6347", label: "4.0 pCi/L (EPA action)" },
  ],
  "chart-pci-rolling": [
    { y: 2.7, color: "#c5e673", label: "2.7 (WHO)" },
    { y: 4.0, color: "#ff6347", label: "4.0 (EPA action)" },
  ],
};

function thresholdLayout(divId, values) {
  const defs = THRESHOLDS[divId] || [];
  if (defs.length === 0) return { shapes: [], annotations: [] };
  const data = values.filter(v => v != null);
  if (data.length === 0) return { shapes: [], annotations: [] };
  const dmax = Math.max(...data);
  const dmin = Math.min(...data);
  const span = Math.max(dmax - dmin, Math.abs(dmax) * 0.05 || 1);
  // Approximate Plotly's autorange padding (~6% each side) so we know which
  // thresholds will fall inside the visible y-axis and which are off-range.
  const yvisMin = dmin - span * 0.06;
  const yvisMax = dmax + span * 0.06;

  const shapes = [];
  const annotations = [];
  let stackedAbove = 0;
  for (const t of defs) {
    if (t.y >= yvisMin && t.y <= yvisMax) {
      // Threshold within visible range: prominent dashed line + boxed label.
      shapes.push({
        type: "line", xref: "paper", x0: 0, x1: 1, yref: "y", y0: t.y, y1: t.y,
        line: { color: t.color, width: 2.2, dash: "dash" },
        layer: "above",
      });
      annotations.push({
        xref: "paper", x: 0.995, yref: "y", y: t.y,
        text: `<b>${t.label}</b>`, showarrow: false,
        xanchor: "right", yanchor: "bottom",
        font: { size: 11, color: "#1f2328" },
        bgcolor: "rgba(255,255,255,0.92)",
        bordercolor: t.color,
        borderwidth: 1.2,
        borderpad: 3,
      });
    } else if (t.y > yvisMax) {
      // Above visible range: pin a small "↑ label" chip at the top.
      annotations.push({
        xref: "paper", x: 0.995, yref: "paper", y: 0.98 - stackedAbove * 0.13,
        text: `↑ <b>${t.label}</b>`, showarrow: false,
        xanchor: "right", yanchor: "top",
        font: { size: 11, color: t.color },
        bgcolor: "rgba(255,255,255,0.92)",
        bordercolor: t.color,
        borderwidth: 1.2,
        borderpad: 3,
      });
      stackedAbove++;
    }
    // Below visible range: skip — extremely unlikely with our threshold sets.
  }
  return { shapes, annotations };
}

function plotChart(divId, times, values, title, yLabel, color) {
  const el = document.getElementById(divId);
  if (!el) return;
  const hasData = values.some(v => v != null);
  if (!hasData) {
    // Purge Plotly's state before swapping innerHTML, otherwise the next call
    // sees stale _fullData and refuses to re-initialize (blank chart).
    if (window.Plotly) Plotly.purge(el);
    el.innerHTML = `<div style="padding:14px;color:#888;font-size:13px;">No data for ${title} in the selected range.</div>`;
    return;
  }
  const trace = {
    x: times,
    y: values,
    type: "scatter",
    mode: "lines+markers",
    line: { width: 2.5, color },
    marker: { size: 4, color },
    name: title,
    connectgaps: false,
  };
  const { shapes, annotations } = thresholdLayout(divId, values);
  const layout = {
    ...PLOTLY_LAYOUT_BASE,
    title: { text: title, font: { size: 14 }, x: 0.01 },
    xaxis: { ...PLOTLY_LAYOUT_BASE.xaxis, title: `Time (${tzAbbrev()})` },
    yaxis: { ...PLOTLY_LAYOUT_BASE.yaxis, title: yLabel },
    shapes,
    annotations,
  };
  Plotly.react(divId, [trace], layout, PLOTLY_CONFIG);
}

// Properly release Plotly's state from a chart div. Setting innerHTML = ""
// alone leaves _fullData/_fullLayout attached to the node; the next
// Plotly.react() then sees stale state and silently no-ops, producing a
// blank chart after the second switch. Plotly.purge tears state down,
// then we wipe the DOM so any stale "No data for X" placeholder is gone.
function purgeChart(divId) {
  const el = document.getElementById(divId);
  if (!el) return;
  if (window.Plotly) Plotly.purge(el);
  el.innerHTML = "";
}

function renderCharts() {
  const d = activeData();
  if (!d) return;
  const rows = filterRows(d.rows);
  const cpmI = fieldIdx(d, "cpm");
  const usvI = fieldIdx(d, "usv_h");
  const pciI = fieldIdx(d, "pci");

  // Series in raw form (Pacific-equivalent Dates for axis display).
  const tUtc = rows.map(r => new Date(r[0]));
  const t    = tUtc.map(toDisplayDate);
  const cpm  = rows.map(r => r[cpmI]);
  const usv  = rows.map(r => r[usvI]);
  const pci  = rows.map(r => r[pciI]);

  // Rolling mean uses real (UTC) timestamps so windowing is correct regardless of display.
  const cpmRoll = rollingMean(tUtc, cpm, ROLLING_WINDOW_MS);
  const pciRoll = d.has_pci ? rollingMean(tUtc, pci, ROLLING_WINDOW_MS) : null;

  // Downsample if the user has it enabled AND we have too many points.
  let bucketSec = null;
  let plot = { t, cpm, usv, pci, cpmRoll, pciRoll };
  if (rows.length > TARGET_POINTS_PER_COUNTER && rows.length >= 2) {
    const spanSec = (tUtc[tUtc.length - 1] - tUtc[0]) / 1000;
    bucketSec = pickBucketSeconds(spanSec);
    const bucketMs = bucketSec * 1000;
    const ds = (vals) => downsampleSeries(t, vals, bucketMs);
    const c   = ds(cpm);
    const u   = ds(usv);
    const cr  = ds(cpmRoll);
    plot = {
      t:        c.times,
      cpm:      c.values,
      usv:      u.values,
      cpmRoll:  cr.values,
      pci:      d.has_pci ? ds(pci).values  : null,
      pciRoll:  d.has_pci ? ds(pciRoll).values : null,
    };
    // Note: t is realigned to bucket centers; uSv & rolling use the same buckets.
  }

  // On a Radon detector the CPM trace is just background noise of the Geiger-
  // Müller tube; pCi is the headline. Hide both CPM charts to keep the radon
  // view focused. uSv/h stays in both views.
  if (d.has_pci) {
    document.getElementById("chart-pci").style.display = "";
    document.getElementById("chart-pci-rolling").style.display = "";
    plotChart("chart-pci",         plot.t, plot.pci,     "Radon activity (pCi/L)",                                "pCi/L",           "#ff7f0e");
    plotChart("chart-pci-rolling", plot.t, plot.pciRoll, "Radon rolling mean (1h)", "pCi/L (rolling)", "#d62728");
    purgeChart("chart-cpm");
    purgeChart("chart-cpm-rolling");
    document.getElementById("chart-cpm").style.display = "none";
    document.getElementById("chart-cpm-rolling").style.display = "none";
  } else {
    purgeChart("chart-pci");
    purgeChart("chart-pci-rolling");
    document.getElementById("chart-pci").style.display = "none";
    document.getElementById("chart-pci-rolling").style.display = "none";
    document.getElementById("chart-cpm").style.display = "";
    document.getElementById("chart-cpm-rolling").style.display = "";
    plotChart("chart-cpm",         plot.t, plot.cpm,     "CPM (counts per minute)",                              "CPM",             "#1f77b4");
    plotChart("chart-cpm-rolling", plot.t, plot.cpmRoll, "CPM rolling mean (1h)",  "CPM (rolling)",   "#9467bd");
  }
  plotChart("chart-usv", plot.t, plot.usv, "Dose rate (uSv/h)", "uSv/h", "#2ca02c");

  // Status caption
  const bucketMsg = bucketSec ? ` · binned to ${fmtBucket(bucketSec)} mean` : "";
  const last = fmtDateTime(new Date());
  document.getElementById("status-caption").textContent =
    `Detector: ${d.name} · last refresh: ${last} ${tzAbbrev()} · ${rows.length.toLocaleString()} raw rows in view${bucketMsg}`;

  renderKpis(d, rows, cpmI, usvI, pciI);
}

function renderKpis(d, rows, cpmI, usvI, pciI) {
  document.getElementById("kpi-rows").textContent = rows.length.toLocaleString();
  const lastWith = (idx) => {
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i][idx] != null) return rows[i][idx];
    return null;
  };
  const cpm = lastWith(cpmI);
  const usv = lastWith(usvI);
  const pci = lastWith(pciI);
  document.getElementById("kpi-cpm").textContent = cpm != null ? String(Math.round(cpm)) : "—";
  document.getElementById("kpi-usv").textContent = usv != null ? usv.toFixed(3)         : "—";
  document.getElementById("kpi-pci").textContent = (d.has_pci && pci != null) ? pci.toFixed(2) : "—";
}

// ---------- MAP -----------------------------------------------------------

let mapInstance = null;
let mapPopup = null;
const MAP_LAYER_ID = "counter-circles";
const MAP_SOURCE_ID = "counters";
const MAP_STYLE = "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json";

function renderLegend() {
  const el = document.getElementById("legend");
  el.innerHTML = CPM_BANDS.map(b =>
    `<span><span class="swatch" style="background:${b.css}"></span>${b.label}</span>`
  ).join("");
}

function counterFeatures() {
  const counters = Object.values(DATA).filter(d => d.lat != null && d.lon != null);
  return {
    type: "FeatureCollection",
    features: counters.map(d => {
      const cpmI = fieldIdx(d, "cpm");
      const usvI = fieldIdx(d, "usv_h");
      const pciI = fieldIdx(d, "pci");
      const last = d.rows.length ? d.rows[d.rows.length - 1] : null;
      const cpm  = last ? last[cpmI] : null;
      const usv  = last ? last[usvI] : null;
      const pci  = last ? last[pciI] : null;
      return {
        type: "Feature",
        geometry: { type: "Point", coordinates: [d.lon, d.lat] },
        properties: {
          param_id: d.param_id,
          name: d.name,
          cpm,
          usv_h: usv,
          pci: d.has_pci ? pci : null,
          last_seen: last ? last[0] : null,
          color: cpmColor(cpm),
          selected: d.param_id === STATE.active,
        },
      };
    }),
  };
}

function popupHtml(props) {
  const ts = props.last_seen
    ? fmtDateTime(new Date(props.last_seen)) + " " + tzAbbrev()
    : "—";
  const cpm = props.cpm != null ? Math.round(props.cpm) : "—";
  const usv = props.usv_h != null ? Number(props.usv_h).toFixed(3) : "—";
  const pci = props.pci != null ? Number(props.pci).toFixed(2) : "—";
  return `<b>${props.name}</b><br/>` +
    `CPM: ${cpm}<br/>` +
    `uSv/h: ${usv}<br/>` +
    `pCi/L: ${pci}<br/>` +
    `Last seen: ${ts}`;
}

function initMap() {
  if (mapInstance) return;
  const counters = Object.values(DATA).filter(d => d.lat != null && d.lon != null);
  if (counters.length === 0) return;
  const latMean = counters.reduce((s, d) => s + d.lat, 0) / counters.length;
  const lonMean = counters.reduce((s, d) => s + d.lon, 0) / counters.length;

  mapInstance = new maplibregl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [lonMean, latMean],
    zoom: 14,
    attributionControl: { compact: true },
    // Single-finger drag scrolls the page; two-finger drag pans the map.
    // ⌘/Ctrl + scroll is required for wheel-zoom on desktop. Mobile users
    // see a brief hint overlay when they try to one-finger drag.
    cooperativeGestures: true,
  });
  mapInstance.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

  mapPopup = new maplibregl.Popup({
    closeButton: false,
    closeOnClick: false,
    offset: 10,
  });

  mapInstance.on("load", () => {
    mapInstance.addSource(MAP_SOURCE_ID, {
      type: "geojson",
      data: counterFeatures(),
    });
    mapInstance.addLayer({
      id: MAP_LAYER_ID,
      type: "circle",
      source: MAP_SOURCE_ID,
      paint: {
        "circle-radius": ["case", ["get", "selected"], 9, 6],
        "circle-color": ["get", "color"],
        "circle-stroke-color": ["case", ["get", "selected"], "#000", "#333"],
        "circle-stroke-width": ["case", ["get", "selected"], 3, 1],
        "circle-opacity": 0.95,
      },
    });

    mapInstance.on("mouseenter", MAP_LAYER_ID, (e) => {
      mapInstance.getCanvas().style.cursor = "pointer";
      const f = e.features[0];
      mapPopup.setLngLat(f.geometry.coordinates).setHTML(popupHtml(f.properties)).addTo(mapInstance);
    });
    mapInstance.on("mouseleave", MAP_LAYER_ID, () => {
      mapInstance.getCanvas().style.cursor = "";
      mapPopup.remove();
    });
    mapInstance.on("click", MAP_LAYER_ID, (e) => {
      const f = e.features[0];
      setActive(f.properties.param_id);
    });
  });
}

function refreshMapMarkers() {
  if (!mapInstance) return;
  const src = mapInstance.getSource(MAP_SOURCE_ID);
  if (src) src.setData(counterFeatures());
}

function gmcmapUrl(paramId) {
  return `https://gmcmap.com/historyData.asp?Param_ID=${paramId}`;
}

function updateDetectorLink() {
  const a = document.getElementById("detector-link");
  if (!a) return;
  if (STATE.active) a.href = gmcmapUrl(STATE.active);
}

function renderMapSection() {
  const d = activeData();
  document.getElementById("map-caption").innerHTML =
    d ? `Active detector: <b>${d.name}</b> · tap a marker to switch.`
      : "Tap a marker to make it the active detector.";
  const tbody = document.querySelector("#loc-table tbody");
  tbody.innerHTML = "";
  if (!d) return;
  const last = d.rows.length ? d.rows[d.rows.length - 1] : null;
  if (!last) return;
  const cpmI = fieldIdx(d, "cpm");
  const usvI = fieldIdx(d, "usv_h");
  const pciI = fieldIdx(d, "pci");
  const cpm  = last[cpmI];
  const usv  = last[usvI];
  const pci  = last[pciI];
  const tr = document.createElement("tr");
  tr.innerHTML =
    `<td><a href="${gmcmapUrl(d.param_id)}" target="_blank" rel="noopener">${d.name} ↗</a></td>` +
    `<td>${d.lat?.toFixed(6) ?? "—"}</td>` +
    `<td>${d.lon?.toFixed(6) ?? "—"}</td>` +
    `<td>${cpm != null ? Math.round(cpm) : "—"}</td>` +
    `<td>${usv != null ? usv.toFixed(3) : "—"}</td>` +
    `<td>${d.has_pci && pci != null ? pci.toFixed(2) : "—"}</td>` +
    `<td>${fmtDateTime(new Date(last[0]))} ${tzAbbrev()}</td>`;
  tbody.appendChild(tr);
}

// ---------- SIDEBAR / STATE WIRING ---------------------------------------

function setActive(paramId) {
  if (!DATA[paramId] || STATE.active === paramId) return;
  STATE.active = paramId;
  localStorage.setItem("active", paramId);
  document.getElementById("detector").value = paramId;
  renderEverything();
}

function renderEverything() {
  updateDetectorLink();
  renderCharts();
  renderMapSection();
  refreshMapMarkers();
}

function populateDetectorSelect() {
  const sel = document.getElementById("detector");
  sel.innerHTML = "";
  for (const c of COUNTERS) {
    const d = DATA[c.param_id];
    if (!d) continue;
    const opt = document.createElement("option");
    opt.value = d.param_id;
    opt.textContent = d.name;
    sel.appendChild(opt);
  }
  if (!DATA[STATE.active]) STATE.active = COUNTERS[0].param_id;
  sel.value = STATE.active;
}

function wireSidebar() {
  document.getElementById("detector").addEventListener("change", e => {
    setActive(e.target.value);
  });

  document.getElementById("range").addEventListener("change", e => {
    STATE.range = e.target.value;
    localStorage.setItem("range", STATE.range);
    document.getElementById("custom-range").classList.toggle("hidden", STATE.range !== "custom");
    renderCharts();
  });
  document.getElementById("range").value = STATE.range;
  document.getElementById("custom-range").classList.toggle("hidden", STATE.range !== "custom");

  const customStart = document.getElementById("custom-start");
  const customEnd   = document.getElementById("custom-end");
  customStart.value = STATE.customStart;
  customEnd.value   = STATE.customEnd;
  customStart.addEventListener("change", e => {
    STATE.customStart = e.target.value;
    localStorage.setItem("customStart", STATE.customStart);
    if (STATE.range === "custom") renderCharts();
  });
  customEnd.addEventListener("change", e => {
    STATE.customEnd = e.target.value;
    localStorage.setItem("customEnd", STATE.customEnd);
    if (STATE.range === "custom") renderCharts();
  });

}

async function refresh() {
  await loadAllData();
  populateDetectorSelect();
  refreshMapMarkers();
  renderEverything();
}

// ---------- INIT ----------------------------------------------------------

(async function init() {
  renderLegend();
  try {
    await loadAllData();
  } catch (e) {
    document.getElementById("status-caption").textContent =
      "Failed to load data: " + e.message;
    console.error(e);
    return;
  }
  populateDetectorSelect();
  wireSidebar();
  initMap();
  renderEverything();
  setInterval(refresh, REFRESH_MS);
})();
