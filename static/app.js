"use strict";

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v, d = 1) => (v == null || Number.isNaN(v) ? "–" : Number(v).toFixed(d));
const fmtInt = (v) => (v == null ? "–" : Math.round(v).toLocaleString());
const signed = (v, d = 2) => (v == null ? "–" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
const pct = (v, d = 1) => (v == null ? "–" : `${Number(v).toFixed(d)}%`);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const dateShort = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "");
const dateLong = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");

let state = { data: null, progressTab: "elo", formMetric: "rating", histPage: 0, filters: { source: "", map: "", outcome: "" } };

/* ---------------------------------------------------------- map pool --- */
const POOL_KEY = "cs2tracker.mapPool";
try { const p = JSON.parse(localStorage.getItem(POOL_KEY)); if (Array.isArray(p) && p.length) Analysis.setPool(p); } catch {}

/* ------------------------------------------------------------- theme --- */
try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
$("#themeBtn").onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", document.documentElement.dataset.theme); } catch {}
  if (state.data) renderView();
};

/* ------------------------------------------------------------ tooltip --- */
const tip = $("#tip");
function showTip(html, ev) {
  tip.innerHTML = html; tip.hidden = false;
  const r = tip.getBoundingClientRect();
  let x = ev.clientX + 14, y = ev.clientY + 14;
  if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - 14;
  if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - 14;
  tip.style.left = x + "px"; tip.style.top = y + "px";
}
const hideTip = () => (tip.hidden = true);
const tipRow = (k, v, color) => `<div class="r"><span>${color ? `<i style="background:${color}"></i>` : ""}${esc(k)}</span><b>${esc(v)}</b></div>`;

/* ------------------------------------------------------------- charts --- */
function niceTicks(min, max, n = 5) {
  if (min === max) { min -= 1; max += 1; }
  const span = max - min, step0 = span / n, mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const out = []; for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

/** Line chart with crosshair tooltip. series: [{name, color, values:[{x, y}]}] */
function lineChart(el, { series, yFmt = (v) => fmt(v, 0), xFmt = dateShort, height = 240, tipTitle = dateLong }) {
  const W = el.clientWidth || 600, H = height, m = { t: 10, r: 14, b: 26, l: 46 };
  const pts = series.flatMap((s) => s.values.filter((p) => p.y != null));
  if (pts.length < 2) { el.innerHTML = `<div class="empty">Not enough data points yet.</div>`; return; }
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const pad = (Math.max(...ys) - Math.min(...ys)) * 0.08 || 1;
  const ticks = niceTicks(Math.min(...ys) - pad, Math.max(...ys) + pad, 4);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const nx = Math.max(2, Math.min(6, xs.length, Math.floor((W - m.l - m.r) / 80)));
  const xt = Array.from({ length: nx }, (_, i) => x0 + ((x1 - x0) * i) / (nx - 1));
  let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img">`;
  svg += `<g class="axis">${ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${m.l - 8}" y="${Y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`).join("")}`;
  svg += xt.map((t, i) => `<text x="${X(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === xt.length - 1 ? "end" : "middle"}">${esc(xFmt(t))}</text>`).join("") + `</g>`;
  for (const s of series) {
    const v = s.values.filter((p) => p.y != null);
    if (!v.length) continue;
    svg += `<path d="${v.map((p, i) => `${i ? "L" : "M"}${X(p.x).toFixed(1)},${Y(p.y).toFixed(1)}`).join("")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    if (v.length <= 40) svg += v.map((p) => `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="3" fill="${s.color}" stroke="${css("--surface-1")}" stroke-width="2"/>`).join("");
  }
  svg += `<line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="${css("--text-muted")}" stroke-dasharray="3 3" visibility="hidden"/>`;
  svg += `<g class="dots"></g><rect x="${m.l}" y="0" width="${W - m.l - m.r}" height="${H}" fill="transparent"/></svg>`;
  el.innerHTML = svg;
  const root = el.querySelector("svg"), xh = root.querySelector(".xhair"), dots = root.querySelector(".dots");
  const allX = [...new Set(xs)].sort((a, b) => a - b);
  root.addEventListener("mousemove", (ev) => {
    const r = root.getBoundingClientRect(), mx = ((ev.clientX - r.left) / r.width) * W;
    const xv = allX.reduce((a, b) => (Math.abs(X(b) - mx) < Math.abs(X(a) - mx) ? b : a));
    xh.setAttribute("x1", X(xv)); xh.setAttribute("x2", X(xv)); xh.setAttribute("visibility", "visible");
    let rows = "", d = "";
    for (const s of series) {
      const p = s.values.find((q) => q.x === xv && q.y != null);
      if (!p) continue;
      rows += tipRow(s.name, yFmt(p.y), s.color);
      d += `<circle cx="${X(p.x)}" cy="${Y(p.y)}" r="5" fill="${s.color}" stroke="${css("--surface-1")}" stroke-width="2"/>`;
    }
    dots.innerHTML = d;
    showTip(`<div class="t">${esc(tipTitle(xv))}</div>${rows}`, ev);
  });
  root.addEventListener("mouseleave", () => { xh.setAttribute("visibility", "hidden"); dots.innerHTML = ""; hideTip(); });
}

/** Diverging bars around a reference value + optional rolling-average line. */
function divergingBars(el, { items, ref = 0, yFmt = (v) => fmt(v, 1), rolling = 0, height = 220 }) {
  const W = el.clientWidth || 600, H = height, m = { t: 10, r: 10, b: 22, l: 42 };
  const vals = items.map((i) => i.v).filter((v) => v != null);
  if (!vals.length) { el.innerHTML = `<div class="empty">No data for this metric.</div>`; return; }
  const ticks = niceTicks(Math.min(ref, ...vals), Math.max(ref, ...vals), 4);
  const y0 = ticks[0], y1 = ticks[ticks.length - 1];
  const Y = (v) => m.t + (1 - (v - y0) / (y1 - y0 || 1)) * (H - m.t - m.b);
  const slot = (W - m.l - m.r) / items.length, bw = Math.max(2, Math.min(18, slot - 2));
  const cx = (i) => m.l + slot * i + slot / 2;
  let svg = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img"><g class="axis">`;
  svg += ticks.map((t) => `<line class="gridline" x1="${m.l}" x2="${W - m.r}" y1="${Y(t)}" y2="${Y(t)}"/><text x="${m.l - 8}" y="${Y(t) + 4}" text-anchor="end">${esc(yFmt(t))}</text>`).join("");
  svg += `<text x="${m.l}" y="${H - 4}">older</text><text x="${W - m.r}" y="${H - 4}" text-anchor="end">latest</text></g>`;
  svg += `<line class="zero" x1="${m.l}" x2="${W - m.r}" y1="${Y(ref)}" y2="${Y(ref)}"/>`;
  const pos = css("--div-pos"), neg = css("--div-neg"), r = Math.min(4, bw / 2);
  items.forEach((it, i) => {
    if (it.v == null) return;
    const up = it.v >= ref, top = Y(Math.max(it.v, ref)), bot = Y(Math.min(it.v, ref)), h = Math.max(1, bot - top), x = cx(i) - bw / 2;
    // rounded only on the data end, flat on the reference line
    const rr = Math.min(r, h);
    const d = up
      ? `M${x},${bot}V${top + rr}Q${x},${top} ${x + rr},${top}H${x + bw - rr}Q${x + bw},${top} ${x + bw},${top + rr}V${bot}Z`
      : `M${x},${top}V${bot - rr}Q${x},${bot} ${x + rr},${bot}H${x + bw - rr}Q${x + bw},${bot} ${x + bw},${bot - rr}V${top}Z`;
    svg += `<path d="${d}" fill="${up ? pos : neg}"/>`;
  });
  if (rolling > 1) {
    const roll = items.map((_, i) => {
      const w = items.slice(Math.max(0, i - rolling + 1), i + 1).map((x) => x.v).filter((v) => v != null);
      return i >= rolling - 1 && w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
    });
    const p = roll.map((v, i) => (v == null ? null : `${cx(i).toFixed(1)},${Y(v).toFixed(1)}`)).filter(Boolean);
    if (p.length > 1) svg += `<path d="M${p.join("L")}" fill="none" stroke="${css("--text-primary")}" stroke-width="2" stroke-linejoin="round"/>`;
  }
  svg += `<g class="hits">${items.map((_, i) => `<rect data-i="${i}" x="${m.l + slot * i}" y="0" width="${slot}" height="${H - m.b}" fill="transparent"/>`).join("")}</g></svg>`;
  el.innerHTML = svg;
  el.querySelectorAll(".hits rect").forEach((rc) => {
    rc.addEventListener("mousemove", (ev) => showTip(items[+rc.dataset.i].tip, ev));
    rc.addEventListener("mouseleave", hideTip);
  });
}

function meter(label, v, { min = 0, max = 100, signedMid = false, d = 1, color } = {}) {
  if (v == null) return `<div class="meter"><span class="lbl">${esc(label)}</span><div class="track"></div><span class="val muted">–</span></div>`;
  const c = color || css("--series-1");
  let fill;
  if (signedMid) {
    const lim = Math.max(Math.abs(min), Math.abs(max)), p = Math.min(1, Math.abs(v) / lim) * 50;
    const col = v >= 0 ? css("--div-pos") : css("--div-neg");
    fill = v >= 0 ? `<div class="fill" style="left:50%;width:${p}%;background:${col}"></div>` : `<div class="fill" style="left:${50 - p}%;width:${p}%;background:${col};border-radius:4px 0 0 4px"></div>`;
    fill += `<div class="mid"></div>`;
  } else {
    fill = `<div class="fill" style="width:${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%;background:${c}"></div>`;
  }
  return `<div class="meter"><span class="lbl">${esc(label)}</span><div class="track">${fill}</div><span class="val">${signedMid ? signed(v, d) : fmt(v, d)}</span></div>`;
}

/* ---------------------------------------------------------------- API --- */
// "server" when served by server.py; "browser" on static hosting (GitHub Pages),
// where engine.js answers the same routes directly from the browser.
let modePromise;
function getMode() {
  modePromise ||= fetch("api/config")
    .then((r) => (r.ok && (r.headers.get("content-type") || "").includes("json") ? "server" : "browser"))
    .catch(() => "browser");
  return modePromise;
}

async function api(path, opts) {
  if ((await getMode()) === "browser") return Engine.handle(path, opts);
  const r = await fetch(path.replace(/^\//, ""), opts);
  const j = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

async function loadHome() {
  const [cfg, tracked] = await Promise.all([api("/api/config"), api("/api/tracked")]);
  const pill = (ok, name, note, okText = "key set") => `<span class="pill"><span class="dot" style="background:${ok ? css("--good") : css("--warn")}"></span>${name}: ${ok ? okText : note}</span>`;
  updateAuth(cfg);
  const faceitOk = cfg.signed_in ? "signed in" : cfg.faceit_builtin ? "built-in key" : "key set";
  const faceitMissing = cfg.faceit_lock ? "sign in to use FACEIT" : "no key – FACEIT data disabled";
  $("#keyStatus").innerHTML = pill(cfg.faceit, "FACEIT", faceitMissing, faceitOk) + pill(cfg.leetify, "Leetify", "no key – works, lower rate limit");
  $("#trackedTitle").hidden = !tracked.length;
  $("#tracked").innerHTML = tracked.map((p) => `
    <div class="card" data-id="${esc(p.steam64)}">
      ${p.avatar ? `<img class="avatar" style="width:40px;height:40px;border-radius:8px" src="${esc(p.avatar)}" alt="">` : `<div class="avatar" style="width:40px;height:40px;font-size:16px;border-radius:8px">${esc((p.name || "?")[0].toUpperCase())}</div>`}
      <div><b>${esc(p.name || p.steam64)}</b><div class="muted" style="font-size:12px">${p.elo ? `ELO ${fmtInt(p.elo)} · ` : ""}${p.premier ? `Premier ${fmtInt(p.premier)} · ` : ""}${p.count} snapshot${p.count === 1 ? "" : "s"}</div></div>
      <button class="x" title="Stop tracking (deletes history)" data-untrack="${esc(p.steam64)}">×</button>
    </div>`).join("");
  $("#tracked").querySelectorAll(".card").forEach((c) => (c.onclick = (ev) => {
    if (ev.target.dataset.untrack) {
      ev.stopPropagation();
      if (confirm("Delete the saved progress history for this player?")) api("/api/untrack", { method: "POST", body: JSON.stringify({ steam64: ev.target.dataset.untrack }) }).then(loadHome);
      return;
    }
    lookup(c.dataset.id);
  }));
}

/* ------------------------------------------------------------ platforms --- */
// Premier and Valve competitive matches come from Leetify (Valve has no public match API).
const PLATFORMS = [
  ["all", "All", () => true],
  ["faceit", "FACEIT", (m) => m.source === "faceit"],
  ["premier", "Premier", (m) => m.source === "premier"],
  ["competitive", "Competitive", (m) => m.source === "competitive"],
  ["other", "Other", (m) => !["faceit", "premier", "competitive"].includes(m.source)],
];
try { state.platform = new URLSearchParams(location.search).get("src") || "all"; } catch { state.platform = "all"; }
const platformDef = (k) => PLATFORMS.find((p) => p[0] === k) || PLATFORMS[0];
/** The report for the selected platform (the full data stays in state.data). */
function viewOf(d) {
  const [key, , keep] = platformDef(state.platform);
  if (key === "all" || !d.matches.some(keep)) return d;
  return Engine.rebuild(d, keep);
}
function renderView() {
  const y = window.scrollY;
  render(viewOf(state.data));
  window.scrollTo({ top: y });
}

async function lookup(q) {
  if (!q) return;
  $("#q").value = q === "demo" ? "" : q;
  $("#welcome").hidden = true; $("#report").hidden = true; $("#error").hidden = true; $("#loading").hidden = false;
  const tab = new URLSearchParams(location.search).get("tab");
  const src = new URLSearchParams(location.search).get("src");
  history.replaceState(null, "", "?q=" + encodeURIComponent(q) + (tab ? "&tab=" + encodeURIComponent(tab) : "") + (src ? "&src=" + encodeURIComponent(src) : ""));
  try {
    const d = await api("/api/player?q=" + encodeURIComponent(q));
    state = { ...state, data: d, histPage: 0, filters: { source: "", map: "", outcome: "" } };
    render(viewOf(d));
  } catch (e) {
    $("#error").textContent = e.message; $("#error").hidden = false; $("#welcome").hidden = false;
  } finally { $("#loading").hidden = true; }
}

/* ------------------------------------------------------------- render --- */
function delta(now, prev, d = 2, invert = false) {
  if (now == null || prev == null) return "";
  const v = now - prev; if (Math.abs(v) < 10 ** -d / 2) return `<span class="muted">±0 vs earlier</span>`;
  const good = invert ? v < 0 : v > 0;
  return `<span class="${good ? "up" : "down"}">${v > 0 ? "▲" : "▼"} ${Math.abs(v).toFixed(d)}</span> <span class="muted">last 10 vs earlier</span>`;
}

function render(d) {
  state.view = d; // the report currently shown (all platforms, or the selected one)
  const fc = d.faceit, lt = d.leetify, o = d.overall || {}, f10 = d.form.last10 || {}, prev = d.form.previous || {};
  const id = d.identity;
  const notices = [];
  if (d.demo) notices.push("Demo mode – synthetic data, nothing is fetched or saved.");
  if (!fc.available) notices.push(`FACEIT: ${esc(fc.reason)}`);
  if (!lt.available) notices.push(`Leetify: ${esc(lt.reason)}`);
  [...(fc.errors || []), ...(lt.errors || [])].forEach((e) => notices.push(esc(e)));
  if (lt.available && lt.privacy && lt.privacy !== "public") notices.push(`Leetify privacy mode: ${esc(lt.privacy)} – some stats may be hidden.`);

  const ranks = [];
  if (fc.available) ranks.push(["FACEIT", `Lvl ${fmtInt(fc.level)} · ${fmtInt(fc.elo)} ELO`]);
  else if (lt.available && lt.ranks.faceit_elo) ranks.push(["FACEIT (via Leetify)", `Lvl ${fmtInt(lt.ranks.faceit)} · ${fmtInt(lt.ranks.faceit_elo)} ELO`]);
  if (lt.available) {
    if (lt.ranks.premier) ranks.push(["Premier", fmtInt(lt.ranks.premier)]);
    if (lt.ranks.leetify != null) ranks.push(["Leetify rating", signed(lt.ranks.leetify, 2)]);
    if (lt.ranks.wingman) ranks.push(["Wingman", `Rank ${lt.ranks.wingman}`]);
    if (lt.ranks.renown) ranks.push(["Renown", fmtInt(lt.ranks.renown)]);
    if (lt.total_matches) ranks.push(["Leetify matches", fmtInt(lt.total_matches)]);
  }
  if (fc.available && fc.lifetime.matches) ranks.push(["FACEIT matches", fmtInt(fc.lifetime.matches)]);
  const comp = lt.available ? lt.ranks.competitive : [];

  const score = d.score;
  const ringC = 2 * Math.PI * 52, ringFill = score == null ? 0 : (score / 100) * ringC;

  const frs = d.matches.map(faceitRating), favg = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const fr = { all: favg(frs), last10: favg(frs.filter((x) => x != null).slice(0, 10)), prev: favg(frs.filter((x) => x != null).slice(10)) };
  if (!lt.available && state.formMetric === "rating") state.formMetric = "frating"; // no Leetify ratings to chart
  const integ = Analysis.integrity(d), coach = Analysis.mapCoaching(d), plan = Analysis.coachingPlan(d, coach), roleEst = Analysis.role(d);
  const integDot = integ.available ? { none: "--good", some: "--warn", high: "--bad", flag: "--bad" }[integ.level] : null;
  const tipCount = coach.available ? coach.maps.reduce((a, m) => a + m.tips.length, 0) : 0;
  const level = fc.available ? `Lvl ${fmtInt(fc.level)} · ${fmtInt(fc.elo)} ELO` : lt.available && lt.ranks.faceit_elo ? `Lvl ${fmtInt(lt.ranks.faceit)} · ${fmtInt(lt.ranks.faceit_elo)} ELO` : "";

  const html = `
  ${notices.length ? `<div class="notice">${notices.join("<br>")}</div>` : ""}
  <nav class="pagebar" id="pagebar" aria-label="Report sections">
    <div class="tabs pagetabs" role="tablist">
      <button role="tab" data-page="summary">Summary</button>
      <button role="tab" data-page="mapplan">Map plan</button>
      <button role="tab" data-page="lobbies">Sessions &amp; teammates</button>
      <button role="tab" data-page="integrity">Integrity check${integDot ? `<span class="tabdot" style="background:${css(integDot)}" aria-hidden="true"></span>` : ""}</button>
      <button role="tab" data-page="coaching">Coaching${tipCount ? `<span class="tabcount">${tipCount}</span>` : ""}</button>
    </div>
    ${platformBar()}
    <div class="pagebar-player" id="pagebarPlayer" aria-hidden="true">
      ${id.avatar ? `<img src="${esc(id.avatar)}" alt="">` : ""}<b>${esc(id.name)}</b>${level ? `<span class="muted">${esc(level)}</span>` : ""}${score != null ? `<span class="muted">Score ${score}</span>` : ""}
    </div>
  </nav>
  <div class="card hero">
    ${id.avatar ? `<img class="avatar" src="${esc(id.avatar)}" alt="">` : `<div class="avatar">${esc((id.name || "?")[0].toUpperCase())}</div>`}
    <div>
      <h1>${esc(id.name)} ${id.country ? `<span class="muted" style="font-size:14px;font-weight:500">${esc(id.country.toUpperCase())}</span>` : ""}</h1>
      <div class="links">
        ${id.steam_url && !d.demo ? `<a href="${esc(id.steam_url)}" target="_blank" rel="noopener">Steam ↗</a>` : ""}
        ${id.faceit_url && !d.demo ? `<a href="${esc(id.faceit_url)}" target="_blank" rel="noopener">FACEIT ↗</a>` : ""}
        ${id.leetify_url && !d.demo ? `<a href="${esc(id.leetify_url)}" target="_blank" rel="noopener">Leetify ↗</a>` : ""}
        <span class="muted">Steam64 ${esc(d.steam64)}</span>
        ${lt.available && lt.first_match ? `<span class="muted">Tracked on Leetify since ${new Date(lt.first_match).toLocaleDateString()}</span>` : ""}
      </div>
      ${roleEst.available ? `<div class="role-line"><span class="role-badge" title="Estimated from ${esc(roleEst.basis)}">${esc(roleEst.primary.name)}</span>${roleEst.secondary ? `<span class="muted">also ${esc(roleEst.secondary.name)}</span>` : ""}<span class="muted">· ${esc({ clear: "clear profile", leaning: "leaning", low: "no clear role" }[roleEst.confidence])}</span></div>` : ""}
      <div class="ranks">${ranks.map(([k, v]) => `<div class="rank"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}</div>
      ${comp && comp.length ? `<div class="muted" style="margin-top:8px;font-size:12px">Competitive map ranks: ${comp.map((c) => `${esc(c.map)} ${c.rank}`).join(" · ")}</div>` : ""}
      ${lt.available && lt.bans && lt.bans.length ? `<div class="down" style="margin-top:8px;font-size:12px">⚠ Platform bans on record: ${lt.bans.map((b) => esc(b.platform)).join(", ")}</div>` : ""}
    </div>
    <div class="score" id="scoreBox" tabindex="0" aria-describedby="tip" aria-label="Performance score ${score ?? "unknown"} out of 100 – hover or focus for the breakdown">
      <div class="score-ring">
        <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" fill="none" stroke="${css("--surface-2")}" stroke-width="10"/>
        <circle cx="60" cy="60" r="52" fill="none" stroke="${css("--accent")}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${ringFill} ${ringC}" transform="rotate(-90 60 60)"/></svg>
        <div class="num">${score ?? "–"}</div>
      </div>
      <div class="lbl">Performance score / 100</div>
    </div>
  </div>

  <section class="page" data-page="summary">
  <div class="section-title">Last ${o.matches || 0} matches · ${state.platform === "all" ? "all platforms" : esc(platformDef(state.platform)[1])}</div>
  <div class="kpis">
    ${kpi("Win rate", pct(o.winrate), delta(f10.winrate, prev.winrate, 1))}
    ${kpi("K/D", fmt(o.kd, 2), delta(f10.kd, prev.kd, 2))}
    ${kpi("ADR", fmt(o.adr, 1), delta(f10.adr, prev.adr, 1))}
    ${kpi("Headshot %", pct(o.hs), delta(f10.hs, prev.hs, 1))}
    ${kpi("Kills / round", fmt(o.kpr, 2), delta(f10.kpr, prev.kpr, 2))}
    ${kpi("Leetify rating", signed(o.rating, 2), delta(f10.rating, prev.rating, 2))}
    ${kpi("FACEIT rating", fmt(fr.all, 2), delta(fr.last10, fr.prev, 2))}
    ${kpi("3K+ per match", fmt(o.mk3plus_per_match, 2), delta(f10.mk3plus_per_match, prev.mk3plus_per_match, 2))}
    ${kpi("Streak", d.streaks.current ? `${d.streaks.current}${d.streaks.current_type === "win" ? "W" : "L"}` : "–", `<span class="muted">best ${d.streaks.longest_win}W · worst ${d.streaks.longest_loss}L</span>`)}
  </div>

  <div class="section-title">Role &amp; playstyle</div>
  ${roleSection(roleEst)}

  <div class="section-title">Kill impact</div>
  ${killImpactSection(Analysis.killImpact(d), d)}

  <div class="section-title">Progress</div>
  <div class="grid g-2-1">
    <div class="card">
      <div class="card-head"><div><h2>Progress over time</h2><div class="sub">${d.demo ? "Synthetic history" : `${d.history.length} snapshot${d.history.length === 1 ? "" : "s"} – one is saved each time you look this player up`}</div></div>
        <div class="tabs" id="progTabs">${[["elo", "FACEIT ELO"], ["premier", "Premier"], ["leetify", "Leetify rating"], ["skills", "Aim / Pos / Util"], ["kd", "K/D"], ["adr", "ADR"]].map(([k, l]) => `<button data-k="${k}" class="${state.progressTab === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
      <div id="progLegend"></div><div class="chart" id="progChart"></div>
    </div>
    <div class="card"><h2>Premier rating by match</h2><div class="sub">From Leetify's recent matches</div><div class="chart" id="premierChart"></div></div>
  </div>

  <div class="card" style="margin-bottom:16px">
    <div class="card-head"><div><h2>Match-by-match form</h2><div class="sub">Last ${Math.min(40, d.matches.length)} matches · bars vs. reference line · line = 5-match rolling average</div></div>
      <div class="tabs" id="formTabs">${[...(lt.available ? [["rating", "Leetify rating"]] : []), ["frating", "FACEIT rating"], ["kd", "K/D"], ["adr", "ADR"], ["hs", "HS %"]].map(([k, l]) => `<button data-k="${k}" class="${state.formMetric === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="chart" id="formChart"></div>
  </div>

  <div class="section-title">Skill profile (Leetify)${state.platform !== "all" ? " · lifetime, all platforms" : ""}</div>
  ${lt.available ? skillSection(lt) : `<div class="card empty">No Leetify data (${esc(lt.reason)}), so aim mechanics – crosshair placement, reaction time, spray – aren't available.${fc.available ? " Utility, entry and clutch stats come from FACEIT instead: see the FACEIT section below and the Coaching tab." : ""}</div>`}

  <div class="section-title">FACEIT</div>
  ${fc.available ? faceitSection(fc) : `<div class="card empty">FACEIT data unavailable – ${esc(fc.reason)}</div>`}

  <div class="section-title">Map pool</div>
  <div class="card table-wrap" style="margin-bottom:16px">${mapTable(d.map_pool, fc.available)}</div>

  <div class="section-title">By platform</div>
  <div class="card table-wrap" style="margin-bottom:16px">${sourceTable(d.by_source)}</div>

  <div class="section-title">Match history</div>
  <div class="card" id="matchCard"></div>
  <p class="muted" style="font-size:12px;margin-top:20px">Data: FACEIT Data API v4 and Leetify Public CS API. Leetify covers Premier, competitive, FACEIT and other sources that it has parsed; FACEIT-only matches Leetify hasn't parsed are added from FACEIT. Ratings and reference thresholds are indicative, not official.</p>
  </section>

  <section class="page" data-page="mapplan" hidden>
    <div class="section-title">Map plan · sides, halves &amp; comebacks</div>
    <div class="card" id="planCard" style="margin-bottom:16px"></div>
  </section>

  <section class="page" data-page="lobbies" hidden>
    <div class="section-title">Sessions, lobbies &amp; teammates</div>
    <div id="lobbyCard"></div>
  </section>

  <section class="page" data-page="integrity" hidden>
    <div class="section-title">Integrity check</div>
    ${integritySection(integ, d)}
  </section>

  <section class="page" data-page="coaching" hidden>
    <div class="section-title">Your coaching plan · all maps</div>
    <div id="planWrap">${planSection(plan, d.steam64)}</div>

    <div class="section-title">Map coaching</div>
    <div class="card" id="coachCard" style="margin-bottom:16px"></div>
  </section>`;

  $("#report").innerHTML = html;
  $("#report").hidden = false;
  $("#welcome").hidden = true;

  $("#progTabs").onclick = (e) => { const k = e.target.dataset.k; if (!k) return; state.progressTab = k; $("#progTabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k)); drawProgress(d); };
  $("#formTabs").onclick = (e) => { const k = e.target.dataset.k; if (!k) return; state.formMetric = k; $("#formTabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k)); drawForm(d); };
  drawMatches(d); drawCoaching(coach); bindPlan(plan, d.steam64); bindScoreTip(d); bindPlatformBar();
  { const k = Analysis.killImpact(d); if (k.available) bindHoverTip($("#killVerdict"), killTipHtml(k)); }
  setupPages(d);
}

/* -------------------------------------------------------------- pages --- */
const PAGES = ["summary", "mapplan", "lobbies", "integrity", "coaching"];

function setupPages(d) {
  const bar = $("#pagebar");
  const show = (page, fromClick) => {
    state.page = page;
    document.querySelectorAll("#report .page").forEach((p) => (p.hidden = p.dataset.page !== page));
    bar.querySelectorAll("[data-page]").forEach((b) => { const on = b.dataset.page === page; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); });
    if (page === "summary") { drawProgress(d); drawPremier(d); drawForm(d); } // charts need a visible width
    if (page === "mapplan") drawMapPlan(d);
    if (page === "lobbies") drawLobbies(d);
    const u = new URL(location.href); u.searchParams.set("tab", page); history.replaceState(null, "", u);
    // when the bar is already stuck, start the new page at its top instead of mid-page
    if (fromClick && bar.classList.contains("stuck"))
      window.scrollTo({ top: window.scrollY + $(".hero").getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom + 1 });
  };
  bar.querySelectorAll("[data-page]").forEach((b) => (b.onclick = () => show(b.dataset.page, true)));
  const fromUrl = new URLSearchParams(location.search).get("tab");
  show(PAGES.includes(fromUrl) ? fromUrl : PAGES.includes(state.page) ? state.page : "summary", false);

  syncPageBar();
}

// Keeps the sticky page bar directly under the (sometimes wrapping) top bar, and shows the
// compact player strip once the player card has scrolled under the bar.
function syncPageBar() {
  document.documentElement.style.setProperty("--topbar-h", `${Math.ceil($(".topbar").getBoundingClientRect().height)}px`);
  const bar = $("#pagebar"), hero = $("#report .hero");
  if (!bar || !hero || $("#report").hidden) return;
  const under = hero.getBoundingClientRect().bottom <= bar.getBoundingClientRect().bottom;
  bar.classList.toggle("stuck", under);
  $("#pagebarPlayer").classList.toggle("show", under);
}
addEventListener("scroll", syncPageBar, { passive: true });
addEventListener("resize", syncPageBar);

/* ------------------------------------------------- integrity & coaching --- */
const STATUS = {
  ok: { icon: "✓", label: "Normal", color: "--good" },
  note: { icon: "!", label: "Unusual", color: "--warn" },
  outlier: { icon: "▲", label: "Outlier", color: "--bad" },
  flag: { icon: "✕", label: "Ban", color: "--bad" },
};

function integritySection(r, d) {
  if (!r.available) return `<div class="card empty">${esc(r.reason)}</div>`;
  const head = { none: ["--good", "No anomalies"], some: ["--warn", "Some unusual values"], high: ["--bad", "Several outliers"], flag: ["--bad", "Ban on record"] }[r.level];
  return `<div class="card" style="margin-bottom:16px">
    <div class="card-head"><div><h2>Statistical anomaly check</h2>
      <div class="sub">Compares aim statistics with a top-pro reference. <b>This is not cheat detection</b> – talented players produce outliers too, and only FACEIT/Valve anti-cheat can establish cheating. Rotations and positioning aren't available from either API.</div></div>
      <span class="pill" style="font-weight:600"><span class="dot" style="background:${css(head[0])}"></span>${head[1]}</span></div>
    <p style="margin:0 0 12px">${esc(r.verdict)}</p>
    <ul class="ins-list">${r.items.map((i) => {
      const s = STATUS[i.status];
      return `<li><span class="ic" style="background:${css(s.color)}" aria-label="${s.label}" title="${s.label}">${s.icon}</span>
        <span>${esc(i.label)} <span class="muted" style="font-size:11px">· ${s.label}</span><span class="ref">${esc(i.ref)}${i.detail ? ` · ${esc(i.detail)}` : ""}</span></span>
        <span class="val">${esc(i.value)}</span>${i.matches?.length ? extremeMatches(i.matches, d) : ""}</li>`;
    }).join("")}</ul>
    ${r.context ? `<p class="muted" style="font-size:12px;margin:12px 0 0">${esc(r.context)}</p>` : ""}
    ${r.missing ? `<p class="muted" style="font-size:12px;margin:8px 0 0">${esc(r.missing)}</p>` : ""}
  </div>`;
}

/** The individual matches behind "Matches with extreme aim values", with FACEIT matchroom links. */
function extremeMatches(ms, d) {
  const cell = (v, extreme, f) => (v == null ? "–" : extreme ? `<b class="down" title="Extreme value">▲ ${f(v)}</b>` : f(v));
  return `<div class="table-wrap" style="grid-column:1/-1;margin-top:6px"><table>
    <thead><tr><th>Date</th><th>Platform</th><th>Map</th><th>Result</th><th class="n">K / D</th><th class="n">HS %</th><th class="n">Preaim</th><th class="n">Reaction</th><th class="n">Rating</th><th>Matchroom</th></tr></thead><tbody>
    ${ms.map((m) => `<tr><td>${esc(dateLong(m.date))}</td><td><span class="src">${esc(m.source)}</span></td><td>${esc(m.map)}</td>
      <td>${m.outcome ? `<span class="badge ${m.outcome}">${m.outcome[0].toUpperCase()}</span> ${esc(m.score || "")}` : "–"}</td>
      <td class="n">${m.kills} / ${m.deaths}</td>
      <td class="n">${cell(m.hs_pct, m.extremeHs, (v) => `${Math.round(v)}%`)}</td>
      <td class="n">${cell(m.aim_preaim, m.extremePreaim, (v) => `${v.toFixed(1)}°`)}</td>
      <td class="n">${cell(m.reaction_ms, m.extremeReaction, (v) => `${Math.round(v)} ms`)}</td>
      <td class="n">${m.rating != null ? signed(m.rating, 2) : faceitRating(m) != null ? `${fmt(faceitRating(m), 2)} <span class="muted" style="font-size:11px">FACEIT</span>` : "–"}</td>
      <td>${roomUrl(m, d) ? `<a href="${esc(roomUrl(m, d))}" target="_blank" rel="noopener" title="Open the FACEIT matchroom">FACEIT ↗</a>` : `<span class="muted" title="Matchrooms exist only for FACEIT matches">–</span>`}</td></tr>`).join("")}
  </tbody></table></div>`;
}

/** Kill impact: do the kills win rounds (Leetify vs HLTV 1.0) and are they followed up (multi-kills)? */
function killImpactSection(k, d) {
  if (!k.available) return `<div class="card empty" style="margin-bottom:16px">${esc(k.reason)}</div>`;
  const tone = { good: "--good", bad: "--bad", neutral: "--text-muted" }[k.verdict.tone];
  const sg = k.snowball.gap, ig = k.impact?.gap;
  const row = (label, value, note) => `<div class="row"><span>${label}${note ? `<span class="ref muted" style="display:block;font-size:11px">${note}</span>` : ""}</span><b>${value}</b></div>`;
  const signedPts = (v, d = 1) => `${v > 0 ? "+" : ""}${v.toFixed(d)}`;
  const empties = (k.emptyGames || []).map((m) => `<tr><td>${esc(dateLong(m.date))}</td><td>${esc(m.map)}</td><td>${m.outcome ? `<span class="badge ${m.outcome}">${m.outcome[0].toUpperCase()}</span>` : "–"} ${esc(m.score || "")}</td>
      <td class="n">${m.kills}/${m.deaths}</td><td class="n">${m.hltv.toFixed(2)}</td><td class="n">${signed(m.rating, 1)}</td>
      <td>${roomUrl(m, d) ? `<a href="${esc(roomUrl(m, d))}" target="_blank" rel="noopener">FACEIT ↗</a>` : "–"}</td></tr>`).join("");
  return `<div class="card" style="margin-bottom:16px">
    <div class="card-head verdict-tip" id="killVerdict" tabindex="0" aria-describedby="tip" aria-label="${esc(k.verdict.name)} – hover or focus to see how this verdict was reached"><div><h2>${esc(k.verdict.name)}</h2><div class="sub" style="margin-bottom:6px">${esc(k.verdict.text)}</div></div>
      <span class="pill"><span class="dot" style="background:${css(tone)}"></span>${k.verdict.tone === "good" ? "Kills convert" : k.verdict.tone === "bad" ? "Kills leak value" : "As expected"}</span></div>
    <div class="grid g2" style="margin:0">
      <div class="statlist">
        ${k.level.leetify != null ? row("Round impact per match", `${signedPts(k.level.leetify)} <span class="muted" style="font-weight:400">Leetify rating</span>`, "0 = average player · +1.0 solid · +2.5 or more high")
          : row("Kill volume per match", `${k.level.hltv.toFixed(2)} <span class="muted" style="font-weight:400">HLTV 1.0</span>`, "1.00 = average player · 1.05 solid · 1.15 or more high")}
        ${ig != null ? row("Round impact vs kill volume", `${signedPts(ig)} <span class="muted" style="font-weight:400">Leetify pts</span>`, `Leetify rating vs what your HLTV 1.0 predicts, over ${k.impact.n} matches (±${k.impact.se.toFixed(1)} noise; ±1.0 is notable)`)
          : row("Round impact vs kill volume", "–", "needs Leetify ratings")}
        ${k.impact ? row("Matches with empty kills", `${Math.round(k.impact.emptyShare)}%`, "Leetify impact 3+ points below what the numbers predict") : ""}
        ${k.impact ? row("Matches where kills swung rounds", `${Math.round(k.impact.swingShare)}%`, "3+ points above") : ""}
      </div>
      <div class="statlist">
        ${row("Kill-rounds with 2+ kills", `${Math.round(100 * k.snowball.share)}% <span class="muted" style="font-weight:400">vs ${Math.round(100 * k.snowball.avgRef)}% for an average player</span>`, `${signedPts(100 * k.snowball.abs, 0)} pts (±7 is notable) · ${Math.round(100 * k.snowball.expected)}% expected for this kill rate`)}
        ${row("Kills per round with a kill", k.snowball.perKillRound.toFixed(2), "how far a round goes once you get the first one")}
      </div>
    </div>
    ${empties ? `<h2 style="margin:16px 0 6px;font-size:14px">Good numbers, little impact</h2><div class="sub">Matches where the kills looked fine but did least for the rounds – worth a demo review</div>
      <div class="table-wrap"><table><thead><tr><th>Date</th><th>Map</th><th>Result</th><th class="n">K/D</th><th class="n">HLTV 1.0</th><th class="n">Leetify</th><th>Matchroom</th></tr></thead><tbody>${empties}</tbody></table></div>` : ""}
    <p class="muted" style="font-size:12px;margin:12px 0 0">No API has round-by-round data. The verdict compares impact (Leetify rating) and multi-kill rounds with an average player; the "vs kill volume" line shows whether the kills are worth more or less than HLTV 1.0 suggests. Calibrated on 598 real matches (Leetify ≈ −9.5 + 10 × HLTV 1.0). Open a teammate's report to see theirs.</p>
  </div>`;
}

/** Estimated role: primary/secondary, traits, and every role's score with the reasons behind it. */
function roleSection(r) {
  if (!r.available) return `<div class="card empty" style="margin-bottom:16px">${esc(r.reason)}</div>`;
  const bar = (x) => `<div class="role-row">
      <div class="role-name">${esc(x.name)}</div>
      <div class="track"><div class="fill" style="width:${x.score ?? 0}%;background:${css(x.id === r.primary.id ? "--accent" : "--series-1")}"></div></div>
      <div class="val">${x.score == null ? `<span class="muted">n/a</span>` : x.score}</div>
      <div class="role-why">${x.why.map((w) => `${esc(w.label)}: <b>${esc(w.value)}</b>`).join(" · ")}</div>
    </div>`;
  return `<div class="card" style="margin-bottom:16px">
    <div class="card-head"><div>
      <h2>${esc(r.primary.name)}${r.secondary ? ` <span class="muted" style="font-weight:500">/ ${esc(r.secondary.name)}</span>` : ""}</h2>
      <div class="sub" style="margin-bottom:6px">${esc(r.primary.blurb)}</div></div>
      <span class="pill">${esc({ clear: "Clear profile", leaning: "Leaning", low: "No clear role" }[r.confidence])}</span></div>
    ${r.traits.length ? `<div class="ranks" style="margin:0 0 14px">${r.traits.map((t) => `<span class="src">${esc(t)}</span>`).join("")}</div>` : ""}
    <div class="role-rows">${r.ranked.map(bar).join("")}</div>
    <p class="muted" style="font-size:12px;margin:12px 0 0">A statistical estimate from ${esc(r.basis)} – each role scores 0–100 from the stats listed; ranges are rough references, not official. Without FACEIT's sniper-kill stats (sign in), AWP can't be judged.</p>
  </div>`;
}

/** Overall coaching plan: top priorities with evidence and actions, strengths, and a practice routine. */
/** Platform toggle: only platforms this player has, with match counts. */
function platformBar() {
  const full = state.data?.matches || [];
  const opts = PLATFORMS.map(([k, label, keep]) => [k, label, k === "all" ? full.length : full.filter(keep).length]).filter(([k, , n]) => k === "all" || n > 0);
  if (opts.length <= 2) return ""; // only one platform – nothing to switch
  const cur = opts.some(([k]) => k === state.platform) ? state.platform : "all";
  return `<div class="tabs srcbar" id="srcBar" role="group" aria-label="Platform">${opts.map(([k, label, n]) =>
    `<button data-src="${k}" class="${k === cur ? "on" : ""}" aria-pressed="${k === cur}">${label} <span class="muted">${n}</span></button>`).join("")}</div>`;
}

function bindPlatformBar() {
  $("#srcBar")?.querySelectorAll("[data-src]").forEach((b) => (b.onclick = () => {
    state.platform = b.dataset.src;
    state.histPage = 0; state.filters.source = ""; // the history's own platform filter would fight the toggle
    const u = new URL(location.href);
    if (state.platform === "all") u.searchParams.delete("src"); else u.searchParams.set("src", state.platform);
    history.replaceState(null, "", u);
    renderView();
  }));
}

/* ------------------------------------------------- performance score tip --- */
/** The performance score split into its parts for this player (same formula as the engine/server). */
function scoreParts(d) {
  const clamp = (x) => Math.max(0, Math.min(100, x)), parts = [];
  const r = d.leetify.available ? d.leetify.rating || {} : {}, o = d.overall || {};
  const add = (label, raw, v, w) => parts.push({ label, raw, v: clamp(v), w });
  if (r.aim != null) add("Aim (Leetify)", r.aim.toFixed(0), r.aim, 0.2);
  if (r.positioning != null) add("Positioning (Leetify)", r.positioning.toFixed(0), r.positioning, 0.15);
  if (r.utility != null) add("Utility (Leetify)", r.utility.toFixed(0), r.utility, 0.1);
  if (o.kd != null) add("K/D", o.kd.toFixed(2), 50 + (o.kd - 1) * 100, 0.2);
  if (o.adr != null) add("ADR", o.adr.toFixed(0), 50 + (o.adr - 77) * 2, 0.15);
  if (o.rating != null) add("Leetify rating", signed(o.rating, 1), 50 + o.rating * 10, 0.2);
  if (o.winrate != null) add("Win rate", `${Math.round(o.winrate)}%`, o.winrate, 0.1);
  const totalW = parts.reduce((a, p) => a + p.w, 0);
  for (const p of parts) { p.share = p.w / totalW; p.points = p.v * p.share; }
  return { parts, total: Math.round(parts.reduce((a, p) => a + p.points, 0)), skipped: totalW < 0.999 };
}

function scoreTipHtml(d) {
  const { parts, total, skipped } = scoreParts(d);
  if (!parts.length) return `<div class="t">No data for a score yet</div>`;
  const tone = (v) => (v >= 60 ? "up" : v < 40 ? "down" : "");
  return `<div class="t">Performance score: ${total} / 100</div>
    <div class="muted" style="margin-bottom:6px">50 is about average. Each part is scored 0–100 and adds its share:</div>
    <table class="scoretip"><thead><tr><th>Part</th><th class="n">Yours</th><th class="n">Score</th><th class="n">Adds</th></tr></thead><tbody>
      ${parts.map((p) => `<tr><td>${esc(p.label)}</td><td class="n">${esc(p.raw)}</td><td class="n ${tone(p.v)}">${Math.round(p.v)}</td><td class="n">+${p.points.toFixed(1)}</td></tr>`).join("")}
      <tr class="sum"><td colspan="3">Total</td><td class="n">${total}</td></tr></tbody></table>
    <div class="muted" style="margin-top:6px">${skipped ? "Some parts have no data for this player, so the others count for more." : "“Adds” = the part's score × its share of the total; green ≥ 60, red < 40."}</div>`;
}

/** Show `html` in the tooltip on hover, keyboard focus, or a tap (phones). */
function bindHoverTip(el, html) {
  if (!el) return;
  const place = (ev) => { showTip(html, ev); tip.classList.add("wide"); };
  const close = () => { hideTip(); tip.classList.remove("wide"); };
  const near = () => { const r = el.getBoundingClientRect(); return { clientX: r.left, clientY: r.bottom }; };
  el.onmousemove = place;
  el.onmouseleave = close;
  el.onfocus = () => place(near());
  el.onblur = close;
  el.onclick = (e) => { if (e.target.closest("a, button")) return; tip.hidden ? place(near()) : close(); };
}
const bindScoreTip = (d) => bindHoverTip($("#scoreBox"), scoreTipHtml(d));

/** How the kill-impact verdict was reached, in plain words. */
function killTipHtml(k) {
  const sgn = (v, dd = 1) => `${v > 0 ? "+" : ""}${v.toFixed(dd)}`;
  const lvl = k.level.leetify, chains = 100 * k.snowball.abs, gap = k.impact?.gap;
  const band = (v, steps) => steps.find(([test]) => test(v))[1];
  const impactBand = lvl != null
    ? band(lvl, [[(v) => v >= 2.5, ["high", "up"]], [(v) => v >= 1.0, ["solid", "up"]], [(v) => v <= -1.5, ["low", "down"]], [() => true, ["around average", ""]]])
    : band(k.level.hltv, [[(v) => v >= 1.15, ["high", "up"]], [(v) => v >= 1.05, ["solid", "up"]], [(v) => v <= 0.9, ["low", "down"]], [() => true, ["around average", ""]]]);
  const chainBand = band(chains, [[(v) => v >= 7, ["more chains than average", "up"]], [(v) => v >= 5, ["slightly more chains", "up"]], [(v) => v <= -7, ["fewer chains than average", "down"]], [() => true, ["about average", ""]]]);
  const gapBand = gap == null ? null : band(gap, [[(v) => v >= 1, ["worth more than they look", "up"]], [(v) => v <= -1, ["worth less than they look", "down"]], [() => true, ["as expected", ""]]]);
  const why = {
    snowball: lvl != null && lvl >= 2.5 ? "Impact is high and kills come in chains (at least 5 points above average)." : "Kills come in chains clearly more often than for an average player.",
    impact: "Impact is high (+2.5 or more), but kills don't come in chains more than usual.",
    solid: "Impact is above average (+1.0 or more) without being high.",
    volume: "Lots of multi-kill rounds, but the kills are worth less than their volume suggests.",
    empty: "The kills are worth clearly less than their volume suggests (1.0+ below the line).",
    oneanddone: "Fewer multi-kill rounds than an average player (7+ points below) and impact isn't high.",
    lowimpact: "Impact is below average (−1.5 or lower).",
    balanced: "None of the signals is clearly above or below average.",
  }[k.verdict.id] || "";
  const line = (label, value, [word, cls], ref) => `<tr><td>${label}</td><td class="n">${value}</td><td class="${cls}">${word}</td></tr>${ref ? `<tr class="refrow"><td colspan="3">${ref}</td></tr>` : ""}`;
  return `<div class="t">Why “${esc(k.verdict.name)}”</div>
    <table class="scoretip"><tbody>
      ${lvl != null ? line("Round impact", sgn(lvl), impactBand, `Leetify rating per match · 0 = average, +1.0 solid, +2.5 high`)
        : line("Kill volume", k.level.hltv.toFixed(2), impactBand, `HLTV 1.0 (no Leetify) · 1.00 = average, 1.15 high`)}
      ${line("Kill chains", `${Math.round(100 * k.snowball.share)}%`, chainBand, `kill-rounds with 2+ kills · ${sgn(chains, 0)} pts vs ${Math.round(100 * k.snowball.avgRef)}% for an average player`)}
      ${gapBand ? line("Kills vs their volume", sgn(gap), gapBand, `Leetify vs what HLTV 1.0 predicts · ±1.0 is notable (${k.impact.n} matches)`) : ""}
    </tbody></table>
    <div style="margin-top:8px"><b>→ ${esc(k.verdict.name)}:</b> ${esc(why)}</div>`;
}

/* coaching tips the viewer dismissed, per player (this browser only) */
const DISMISS_KEY = "cs2tracker.dismissed";
const dismissedFor = (sid) => { try { return (JSON.parse(localStorage.getItem(DISMISS_KEY)) || {})[sid] || []; } catch { return []; } };
function setDismissed(sid, ids) {
  try { const all = JSON.parse(localStorage.getItem(DISMISS_KEY)) || {}; all[sid] = ids; localStorage.setItem(DISMISS_KEY, JSON.stringify(all)); } catch {}
}

/** Overall coaching plan: top priorities (dismissable – the next one moves up), more, routine, strengths. */
function planSection(plan, sid) {
  const dismissed = dismissedFor(sid);
  const visible = plan.areas.filter((a) => !dismissed.includes(a.id));
  const priorities = visible.slice(0, 3), more = visible.slice(3, 8); // the rest stays in reserve for dismissals
  const restore = dismissed.length ? `<button class="btn small ghost" id="planRestore" type="button">Show dismissed (${dismissed.length})</button>` : "";
  if (!priorities.length)
    return `<div class="card" style="margin-bottom:16px"><div class="card-head"><h2>${plan.areas.length ? "All tips dismissed" : "No clear weak spots"}</h2>${restore}</div>
      <p class="muted" style="margin:6px 0 0">${plan.areas.length ? "You've dismissed every coaching tip for this player." : `Nothing stands out against the reference values across your last ${plan.matches} matches – keep going, and check the map tips below for smaller gains.`}</p></div>`;
  const prio = (a, i) => `
    <div class="card prio">
      <button class="prio-x" type="button" data-dismiss="${esc(a.id)}" title="Dismiss this tip – the next one moves up" aria-label="Dismiss ${esc(a.title)}">×</button>
      <div class="prio-head"><span class="prio-num">${i + 1}</span><div><h2>${esc(a.title)}</h2>
        ${a.tier ? `<div class="sub" style="margin:2px 0 0">${{ grow: "Not weak – but the next step up", map: "Map-specific tip", lobby: "From your sessions & teammates" }[a.tier]}</div>` : ""}
        ${a.maps.length ? `<div class="sub" style="margin:2px 0 0">Shows up most on: ${esc(a.maps.join(", "))}</div>` : ""}</div></div>
      ${a.evidence.length ? `<div class="statlist" style="margin:10px 0">${a.evidence.map((e) => `<div class="row"><span>${esc(e.label)}<span class="ref muted" style="display:block;font-size:11px">${esc(e.ref)}</span></span><b class="${e.pattern ? "" : "down"}">${esc(e.value)}</b></div>`).join("")}</div>` : ""}
      <div class="prio-do">What to do</div>
      <ul class="todo">${a.actions.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
    </div>`;
  // a weekly routine from the visible priorities' first actions
  const routine = [{ area: "Every session", text: "Warm up 10–15 minutes before your first match: deathmatch at head height, then one prefire run of the map you'll play." },
    ...priorities.flatMap((a) => a.actions.slice(0, 2).map((text) => ({ area: a.title, text })))];
  return `
  ${plan.source ? `<div class="notice">${esc(plan.source)}</div>` : ""}
  ${restore ? `<div style="display:flex;justify-content:flex-end;margin:-6px 0 8px">${restore}</div>` : ""}
  <div class="grid g3 prios">${priorities.map(prio).join("")}</div>
  ${more.length ? `<div class="card" style="margin-bottom:16px"><h2>Also worth a look</h2><div class="sub">Lower priority – these move up when you dismiss a tip above</div>
    <ul class="ins-list">${more.map((a) => `<li><span class="ic" style="background:${css("--warn")}" aria-label="improve">!</span><span>${esc(a.title)}<span class="ref">${esc(a.evidence.map((e) => `${e.label}: ${e.value}`).join(" · ") || `on ${a.maps.join(", ")}`)}</span></span><span></span></li>`).join("")}</ul></div>` : ""}
  <div class="grid g2">
    <div class="card"><h2>Practice routine</h2><div class="sub">A weekly checklist built from your top priorities</div>
      <ul class="todo">${routine.map((r) => `<li><span class="muted" style="font-size:11px;display:block">${esc(r.area)}</span>${esc(r.text)}</li>`).join("")}</ul></div>
    <div class="card"><h2>Keep doing</h2><div class="sub">Already at a good level – don't lose these</div>
      ${plan.keep.length ? `<ul class="ins-list">${plan.keep.map((k) => `<li><span class="ic" style="background:${css("--good")}" aria-label="strength">+</span><span>${esc(k.label)}</span><span class="val">${esc(k.value)}</span></li>`).join("")}</ul>` : `<div class="empty" style="padding:12px 0">No stats clearly above the reference values yet.</div>`}</div>
  </div>
  <p class="muted" style="font-size:12px;margin:-4px 0 16px">Priorities are ranked by how far a stat is from a rough rule-of-thumb reference (not an official benchmark), and rise when the same problem appears on several maps. Dismissed tips are remembered for this player in this browser.</p>`;
}

function bindPlan(plan, sid) {
  const wrap = $("#planWrap");
  if (!wrap) return;
  const redraw = () => { wrap.innerHTML = planSection(plan, sid); bindPlan(plan, sid); };
  wrap.querySelectorAll("[data-dismiss]").forEach((b) => (b.onclick = () => { setDismissed(sid, [...dismissedFor(sid), b.dataset.dismiss]); redraw(); }));
  const r = $("#planRestore"); if (r) r.onclick = () => { setDismissed(sid, []); redraw(); };
}

/* ----------------------------------------------------------- map plan --- */
function drawMapPlan(d) {
  const el = $("#planCard");
  const plan = Analysis.mapPlan(d);
  if (!plan.available) { el.innerHTML = `<h2>Map plan</h2><div class="empty">${esc(plan.reason)}</div>`; return; }
  const sel = state.planMap && plan.maps.some((m) => m.map === state.planMap) ? state.planMap : plan.maps[0].map;
  const m = plan.maps.find((x) => x.map === sel), o = plan.overall;
  const r12 = (v) => ((v / 100) * 12).toFixed(1), pc = (v) => `${Math.round(v)}%`;
  // heat cell: tinted by distance from your own average (green = better, red = worse); text stays text-colored
  const heat = (v, avg, n, f, minN = 4, note = "") => {
    if (v == null || (n != null && n < minN)) return `<td class="n muted" title="${n != null ? `${n} games – too few` : "no data"}">–</td>`;
    const diff = avg == null ? 0 : v - avg, a = Math.min(45, Math.abs(diff) * 2.2);
    const bg = Math.abs(diff) < 3 ? "transparent" : `color-mix(in srgb, var(${diff > 0 ? "--div-pos" : "--div-neg"}) ${a}%, transparent)`;
    return `<td class="n heat" style="background:${bg}" title="${diff >= 0 ? "+" : ""}${diff.toFixed(0)} vs your average${n != null ? ` · ${n} games` : ""}">${f(v)}${note}</td>`;
  };
  const halvesNote = (halves, rounds) => `<span class="nsub" title="from ${halves} ${halves === 1 ? "half" : "halves"} (${rounds} rounds)${halves < 3 ? " – very small sample" : ""}">${halves}</span>`;
  // side cells: fewer than 3 halves is an anecdote, so show it greyed out and untinted
  const sideCell = (v, avg, t, played) => (v != null && t.sided < 3
    ? `<td class="n thin" title="only ${t.sided} ${t.sided === 1 ? "half" : "halves"} – too few to call a pattern">${r12(v)}${halvesNote(t.sided, played)}</td>`
    : heat(v, avg, null, r12, 4, v != null ? halvesNote(t.sided, played) : ""));
  const avgCell = (v, f) => `<td class="n">${v == null ? "–" : f(v)}</td>`;
  const table = `<div class="table-wrap"><table class="heattable"><thead><tr><th>Map</th><th class="n">Games</th><th class="n">Win %</th>
      <th class="n" title="Rounds won per 12 on CT; the small number is how many halves it's based on">CT /12</th><th class="n" title="Rounds won per 12 on T; the small number is how many halves it's based on">T /12</th>
      <th class="n">Start CT</th><th class="n">Start T</th><th class="n">Lead held</th><th class="n">Comebacks</th><th class="n">Close games</th></tr></thead><tbody>
    ${plan.maps.map((x) => { const t = x.stats; return `<tr class="${x.map === sel ? "sel" : ""}" data-map="${esc(x.map)}" tabindex="0" title="Show strengths and weaknesses on ${esc(x.map)}">
      <td><b>${esc(x.map)}</b></td><td class="n">${t.n}</td>${heat(t.winrate, o.winrate, t.n, pc, 3)}
      ${sideCell(t.ctPct, o.ctPct, t, t.ctPlayed)}${sideCell(t.tPct, o.tPct, t, t.tPlayed)}
      ${heat(t.startCT.rate, o.startCT.rate, t.startCT.n, pc)}${heat(t.startT.rate, o.startT.rate, t.startT.n, pc)}
      ${heat(t.lead.rate, o.lead.rate, t.lead.n, pc)}${heat(t.trail.rate, o.trail.rate, t.trail.n, pc)}${heat(t.close.rate, o.close.rate, t.close.n, pc)}</tr>`; }).join("")}
    <tr class="avg"><td>All maps</td><td class="n">${o.n}</td>${avgCell(o.winrate, pc)}${avgCell(o.ctPct, r12)}${avgCell(o.tPct, r12)}
      ${avgCell(o.startCT.rate, pc)}${avgCell(o.startT.rate, pc)}${avgCell(o.lead.rate, pc)}${avgCell(o.trail.rate, pc)}${avgCell(o.close.rate, pc)}</tr>
    </tbody></table></div>`;
  const list = (items, good) => items.length
    ? `<ul class="ins-list">${items.map((i) => `<li><span class="ic" style="background:${css(good ? "--good" : "--bad")}" aria-label="${good ? "strength" : "weakness"}">${good ? "+" : "−"}</span>
        <span><b>${esc(i.title)}</b><span class="ref" style="font-size:12px;color:var(--text-secondary)">${esc(i.detail)}</span>${i.action ? `<span class="ref">→ ${esc(i.action)}</span>` : ""}</span><span></span></li>`).join("")}</ul>`
    : `<div class="empty" style="padding:12px 0">${good ? "Nothing clearly above your average here yet." : "No clear weak spots here compared with your average."}</div>`;
  el.innerHTML = `
    <h2>Your sides, halves and comebacks per map</h2>
    <div class="sub">Team results from FACEIT half scores; starting side from Leetify. Cells are tinted against your own average – green better, red worse; "–" means too few games. Click a map to see its strengths and weaknesses.</div>
    ${plan.missing.length ? `<div class="notice">${plan.missing.map(esc).join("<br>")}</div>` : ""}
    ${table}
    <div class="card-head" style="margin-top:20px"><h2>${esc(sel)} · ${m.stats.n} games</h2><span class="muted" style="font-size:12px">Compared with your other Active Duty maps and your average</span></div>
    <div class="grid g2" style="margin:8px 0 0">
      <div><div class="prio-do" style="margin-bottom:6px">Strengths</div>${list(m.strengths, true)}</div>
      <div><div class="prio-do" style="margin-bottom:6px">Weaknesses &amp; what to do</div>${list(m.weaknesses, false)}</div>
    </div>
    <p class="muted" style="font-size:12px;margin:14px 0 0">Coverage: half scores for ${plan.coverage.halves} and starting side for ${plan.coverage.sides} of ${o.n} Active Duty matches. Side, halftime and comeback numbers are team results.</p>`;
  el.querySelectorAll("tr[data-map]").forEach((tr) => {
    const pick = () => { state.planMap = tr.dataset.map; drawMapPlan(d); };
    tr.onclick = pick;
    tr.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } };
  });
}

/* ------------------------------------------------- sessions & teammates --- */
function drawLobbies(d) {
  const el = $("#lobbyCard"), L = Analysis.lobbies(d);
  if (!L.available) { el.innerHTML = `<div class="card empty">${esc(L.reason)}</div>`; return; }
  const pc = (v) => (v == null ? "–" : `${Math.round(v)}%`), f2 = (v) => (v == null ? "–" : v.toFixed(2));
  const avg = L.overall;
  // heat cell vs your overall: tinted green/red, text stays text-colored; small groups shown muted
  const heat = (v, base, n, f, scale) => {
    if (v == null || n < 5) return `<td class="n muted" title="${n} games – too few">${v == null ? "–" : f(v)}</td>`;
    const diff = base == null ? 0 : v - base, a = Math.min(45, (Math.abs(diff) / scale) * 12);
    const bg = Math.abs(diff) < scale * 0.25 ? "transparent" : `color-mix(in srgb, var(${diff > 0 ? "--div-pos" : "--div-neg"}) ${a}%, transparent)`;
    return `<td class="n heat" style="background:${bg}">${f(v)}</td>`;
  };
  const table = (rows, first) => `<div class="table-wrap"><table class="heattable"><thead><tr><th>${first}</th><th class="n">Games</th><th class="n">Win %</th><th class="n">FACEIT rating</th><th class="n">K/D</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td>${esc(r.label)}</td><td class="n">${r.n}</td>${heat(r.winrate, avg.winrate, r.n, pc, 10)}${heat(r.rating, avg.rating, r.n, f2, 0.1)}${heat(r.kd, avg.kd, r.n, f2, 0.1)}</tr>`).join("")}
    </tbody></table></div>`;
  const list = (items, good) => items.length
    ? `<ul class="ins-list">${items.map((i) => `<li><span class="ic" style="background:${css(good ? "--good" : "--bad")}" aria-label="${good ? "strength" : "weakness"}">${good ? "+" : "−"}</span>
        <span><b>${esc(i.title)}</b><span class="ref" style="font-size:12px;color:var(--text-secondary)">${esc(i.detail)}</span>${i.action ? `<span class="ref">→ ${esc(i.action)}</span>` : ""}</span><span></span></li>`).join("")}</ul>`
    : `<div class="empty" style="padding:12px 0">${good ? "Nothing stands out yet." : "No clear weak spots here."}</div>`;
  const t = L.team;
  const teamCard = t ? `<div class="statlist">
      <div class="row"><span>Top fragger in your team</span><b>${pc(t.topFragRate)} <span class="muted" style="font-weight:400">of ${t.n} matches · 20% = average</span></b></div>
      <div class="row"><span>Average place on the scoreboard</span><b>${t.avgRank.toFixed(1)} <span class="muted" style="font-weight:400">of 5</span></b></div>
      <div class="row"><span>Share of your team's kills</span><b>${pc(100 * t.kshare)}</b></div>
      <div class="row"><span>Share of your team's damage</span><b>${t.dshare == null ? "–" : pc(100 * t.dshare)}</b></div>
      <div class="row"><span>Win % when you top-frag / when you don't</span><b>${pc(t.winTop)} / ${pc(t.winOther)}</b></div>
      <div class="row"><span>Your kill share in wins / losses</span><b>${t.kshareWin == null ? "–" : pc(100 * t.kshareWin)} / ${t.kshareLoss == null ? "–" : pc(100 * t.kshareLoss)}</b></div>
    </div>` : `<div class="empty">Needs FACEIT match stats (sign in).</div>`;
  const duoTable = L.duos.length ? `<div class="table-wrap"><table class="heattable"><thead><tr><th>Teammate</th><th class="n">Games together</th><th class="n">Win % with / without</th><th class="n">Your rating with / without</th></tr></thead><tbody>
    ${L.duos.map((x) => `<tr><td><a href="?q=${encodeURIComponent(x.nick)}&tab=summary" title="Open ${esc(x.nick)}'s report"><b>${esc(x.nick)}</b></a>
      <a class="extlink" href="https://www.faceit.com/en/players/${encodeURIComponent(x.nick)}" target="_blank" rel="noopener" title="${esc(x.nick)} on FACEIT">FACEIT ↗</a>
      <span class="muted" style="font-size:11px">${pc(x.share)} of your matches</span></td><td class="n">${x.with.n}</td>
      ${heat(x.with.winrate, x.without.winrate, x.with.n, (v) => `${pc(v)} <span class="muted" style="font-weight:400">/ ${pc(x.without.winrate)}</span>`, 10)}
      ${heat(x.with.rating, x.without.rating, x.with.n, (v) => `${f2(v)} <span class="muted" style="font-weight:400">/ ${f2(x.without.rating)}</span>`, 0.1)}</tr>`).join("")}
    </tbody></table></div>` : `<div class="empty">No teammate in 5 or more of your recent FACEIT matches.</div>`;
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px">
      <h2>What your sessions and lobbies say</h2>
      <div class="sub">From ${L.withCtx} FACEIT matches with line-ups and timing (${L.sessionCount} sessions). Performance = FACEIT rating per match (1.00 ≈ average); small groups (under 5 games) are left out.</div>
      <div class="grid g2" style="margin:8px 0 0">
        <div><div class="prio-do" style="margin-bottom:6px">Strengths</div>${list(L.insights.strengths, true)}</div>
        <div><div class="prio-do" style="margin-bottom:6px">Weaknesses &amp; what to do</div>${list(L.insights.weaknesses, false)}</div>
      </div>
    </div>
    <div class="grid g2">
      <div class="card"><h2>Opponent strength</h2><div class="sub">Opponents' average FACEIT level vs your team's · they averaged level ${L.avgOppLevel == null ? "–" : L.avgOppLevel.toFixed(1)}</div>${table(L.strength, "Lobby")}</div>
      <div class="card"><h2>Your place in the team</h2><div class="sub">From each match's scoreboard</div>${teamCard}</div>
    </div>
    <div class="grid g2">
      <div class="card"><h2>Sessions</h2><div class="sub">By match number in a session (a break of 90+ minutes starts a new one)</div>${table(L.sessions, "Match in session")}
        <div class="statlist" style="margin-top:10px"><div class="row"><span>Next match after a win / after a loss</span><b>${f2(L.tilt.afterWin.rating)} / ${f2(L.tilt.afterLoss.rating)} <span class="muted" style="font-weight:400">rating</span></b></div></div></div>
      <div class="card"><h2>Time of day</h2><div class="sub">Your local time when the match started</div>${table(L.timeOfDay, "Time")}</div>
    </div>
    <div class="card" style="margin-bottom:16px"><h2>Duos</h2><div class="sub">Teammates in 5+ of your recent FACEIT matches – your results with them vs without them</div>${duoTable}</div>`;
}

const COACH_LABELS = { util_pr: "utility usage", flash_eff: "flash effectiveness", flash_team: "team flashes", util_death: "using utility before dying",
  he_dmg: "HE damage", trade: "trading teammates", traded: "getting traded", survival: "survival", preaim: "crosshair placement" };

function drawCoaching(c) {
  const el = $("#coachCard");
  if (!c.available) { el.innerHTML = `<div class="empty">${esc(c.reason)}</div>`; return; }
  const sel = state.coachMap && c.maps.some((m) => m.map === state.coachMap) ? state.coachMap : c.maps[0].map;
  const m = c.maps.find((x) => x.map === sel), p = m.stats, o = m.others || {};
  const row = (label, a, b, f, better) => {
    if (a == null && b == null) return ""; // metric not available from this player's data sources
    const diff = a != null && b != null ? (better === "high" ? a - b : b - a) : null;
    const cls = diff == null || Math.abs(diff) < 1e-9 ? "" : diff > 0 ? "up" : "down";
    return `<tr><td>${label}</td><td class="n ${cls}"><b>${a == null ? "–" : f(a)}</b></td><td class="n muted">${b == null ? "–" : f(b)}</td></tr>`;
  };
  const f1 = (v) => v.toFixed(1), f2 = (v) => v.toFixed(2), p0 = (v) => `${Math.round(v)}%`, sg = (v) => (Math.abs(v) < 0.05 ? "0.0" : (v > 0 ? "+" : "") + v.toFixed(1));
  el.innerHTML = `
    <div class="card-head"><div><h2>What to work on, per map</h2><div class="sub">Active Duty maps only (${esc(c.pool.join(", "))}), each compared with your other Active Duty maps. Green = better, red = worse.${c.skipped.length ? ` Too few matches (under ${c.minMatches}): ${esc(c.skipped.join(", "))}.` : ""}${c.outOfPool.length ? ` Not in the competitive pool, so no tips: ${esc(c.outOfPool.join(", "))}.` : ""}</div></div>
      <select id="coachSel" aria-label="Map">${c.maps.map((x) => `<option value="${esc(x.map)}" ${x.map === sel ? "selected" : ""}>${esc(x.map)} (${x.stats.n})${x.tips.length ? ` · ${x.tips.length} tip${x.tips.length > 1 ? "s" : ""}` : ""}</option>`).join("")}</select></div>
    <div class="grid g2" style="margin:0">
      <div>
        ${m.tips.length ? `<ul class="ins-list">${m.tips.map((t) => `<li><span class="ic" style="background:${css("--warn")}" aria-label="tip">!</span><span>${esc(t.text)}</span><span></span></li>`).join("")}</ul>`
          : `<div class="empty" style="padding:12px 0">No clear weak spots on ${esc(sel)} compared with your other maps.</div>`}
        ${m.strengths.length ? `<p class="muted" style="font-size:12px;margin-top:12px">Better on ${esc(sel)} than elsewhere: ${m.strengths.map((g) => esc(g.title.toLowerCase())).join(", ")}.</p>` : ""}
      </div>
      <div class="table-wrap"><table><thead><tr><th>${esc(sel)} · ${p.n} matches</th><th class="n">This map</th><th class="n">Other maps</th></tr></thead><tbody>
        ${row("Win rate", p.winrate, o.winrate, p0, "high")}
        ${row("Leetify rating", p.rating, o.rating, sg, "high")}
        ${row("FACEIT rating", p.frating, o.frating, f2, "high")}
        ${row("CT-side rating", p.ct, o.ct, sg, "high")}
        ${row("T-side rating", p.t, o.t, sg, "high")}
        ${row("K/D", p.kd, o.kd, f2, "high")}
        ${row("ADR", p.adr, o.adr, f1, "high")}
        ${row("Grenades / round", p.util_pr, o.util_pr, f2, "high")}
        ${row("Enemies flashed / flash", p.flash_eff, o.flash_eff, f2, "high")}
        ${row("Teammates flashed / flash", p.flash_team, o.flash_team, f2, "low")}
        ${row("HE damage / grenade", p.he_dmg, o.he_dmg, f1, "high")}
        ${row("Utility damage / round", p.util_dmg, o.util_dmg, f1, "high")}
        ${row("Unused utility at death", p.util_death, o.util_death, (v) => `$${Math.round(v)}`, "low")}
        ${row("Entry duels won", p.entry_success, o.entry_success, p0, "high")}
        ${row("1v1 clutches won", p.clutch_1v1, o.clutch_1v1, p0, "high")}
        ${row("Trade kill success", p.trade, o.trade, p0, "high")}
        ${row("Deaths traded", p.traded, o.traded, p0, "high")}
        ${row("Rounds survived", p.survival, o.survival, p0, "high")}
        ${row("Preaim", p.preaim, o.preaim, (v) => `${v.toFixed(1)}°`, "low")}
      </tbody></table></div>
    </div>`;
  $("#coachSel").onchange = (e) => { state.coachMap = e.target.value; drawCoaching(c); };
}

const kpi = (k, v, dl) => `<div class="card kpi"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="d">${dl || "&nbsp;"}</div></div>`;


function skillSection(lt) {
  const r = lt.rating, s = lt.stats || {};
  const row = (k, v) => `<div class="row"><span>${esc(k)}</span><b>${v}</b></div>`;
  return `<div class="grid g3">
    <div class="card"><h2>Ratings</h2><div class="sub">Aim/positioning/utility 0–100 (≈50 average). Others: Leetify rating contribution</div>
      ${meter("Aim", r.aim)}${meter("Positioning", r.positioning)}${meter("Utility", r.utility)}
      ${meter("Clutch", r.clutch, { signedMid: true, min: -8, max: 8, d: 2 })}${meter("Opening", r.opening, { signedMid: true, min: -8, max: 8, d: 2 })}
      ${meter("CT side", r.ct, { signedMid: true, min: -8, max: 8, d: 2 })}${meter("T side", r.t, { signedMid: true, min: -8, max: 8, d: 2 })}
    </div>
    <div class="card"><h2>Mechanics</h2><div class="sub">Aim fundamentals</div><div class="statlist">
      ${row("Reaction time", s.reaction_time_ms != null ? `${fmt(s.reaction_time_ms, 0)} ms` : "–")}
      ${row("Crosshair placement (preaim)", s.preaim != null ? `${fmt(s.preaim, 1)}°` : "–")}
      ${row("Accuracy (enemy spotted)", pct(s.accuracy_enemy_spotted))}
      ${row("Head accuracy", pct(s.accuracy_head))}
      ${row("Spray accuracy", pct(s.spray_accuracy))}
      ${row("Counter-strafing (good shots)", pct(s.counter_strafing_good_shots_ratio))}
    </div></div>
    <div class="card"><h2>Utility, trades &amp; openings</h2><div class="sub">Per-match averages</div><div class="statlist">
      ${row("Flashes thrown", fmt(s.flashbang_thrown, 1))}
      ${row("Enemies flashed / flash", fmt(s.flashbang_hit_foe_per_flashbang, 2))}
      ${row("Teammates flashed / flash", fmt(s.flashbang_hit_friend_per_flashbang, 2))}
      ${row("Avg blind duration", s.flashbang_hit_foe_avg_duration != null ? `${fmt(s.flashbang_hit_foe_avg_duration, 2)} s` : "–")}
      ${row("Flashes leading to kill", fmt(s.flashbang_leading_to_kill, 1))}
      ${row("HE damage (enemies)", fmt(s.he_foes_damage_avg, 1))}
      ${row("Unused utility on death", s.utility_on_death_avg != null ? `$${fmt(s.utility_on_death_avg, 0)}` : "–")}
      ${row("Trade kill success", pct(s.trade_kills_success_percentage))}
      ${row("Traded death success", pct(s.traded_deaths_success_percentage))}
      ${row("Opening duel win – CT / T", `${pct(s.ct_opening_duel_success_percentage, 0)} / ${pct(s.t_opening_duel_success_percentage, 0)}`)}
      ${row("Opening aggression success – CT / T", `${pct(s.ct_opening_aggression_success_rate, 0)} / ${pct(s.t_opening_aggression_success_rate, 0)}`)}
    </div></div>
  </div>`;
}

function faceitSection(fc) {
  const l = fc.lifetime, row = (k, v) => `<div class="row"><span>${esc(k)}</span><b>${v}</b></div>`;
  const r01 = (v) => (v == null ? "–" : pct(v <= 1 ? v * 100 : v, 0));
  const recent = (l.recent_results || []).map((r) => `<span class="badge ${r === "1" ? "win" : "loss"}">${r === "1" ? "W" : "L"}</span>`).join(" ");
  return `<div class="grid g2">
    <div class="card"><h2>Lifetime</h2><div class="sub">${esc(fc.region || "")} · ${fmtInt(l.matches)} matches</div><div class="statlist">
      ${row("Win rate", pct(l.winrate, 0))}${row("Wins", fmtInt(l.wins))}${row("Average K/D", fmt(l.kd, 2))}
      ${row("ADR", fmt(l.adr, 1))}${row("Headshot %", pct(l.hs, 0))}
      ${row("Current / longest win streak", `${fmtInt(l.current_streak)} / ${fmtInt(l.longest_streak)}`)}
      ${row("Recent results", recent || "–")}
    </div></div>
    <div class="card"><h2>Situational</h2><div class="sub">FACEIT extended stats (when available)</div><div class="statlist">
      ${row("Entry success rate", r01(l.entry_success))}${row("1v1 win rate", r01(l.clutch_1v1))}${row("1v2 win rate", r01(l.clutch_1v2))}
      ${row("Flash success rate", r01(l.flash_success))}${row("Utility damage / round", fmt(l.utility_dpr, 1))}${row("Sniper kill rate", r01(l.sniper_kill_rate))}
    </div></div>
  </div>`;
}

function mapTable(pool, hasFaceit) {
  if (!pool.length) return `<div class="empty">No map data.</div>`;
  const wr = (v) => (v == null ? "–" : `${fmt(v, 0)}%<span class="wr-bar"><i style="width:${Math.max(0, Math.min(100, v))}%"></i></span>`);
  return `<table><thead><tr><th>Map</th><th class="n">Recent matches</th><th class="n">Win rate</th><th class="n">K/D</th><th class="n">ADR</th><th class="n">HS %</th><th class="n">Leetify rating</th>
    ${hasFaceit ? `<th class="n">FACEIT matches</th><th class="n">FACEIT WR</th><th class="n">FACEIT K/D</th>` : ""}</tr></thead><tbody>
    ${pool.map((r) => `<tr><td><b>${esc(r.map)}</b></td><td class="n">${r.recent.matches ?? "–"}</td><td class="n">${wr(r.recent.winrate)}</td>
      <td class="n">${fmt(r.recent.kd, 2)}</td><td class="n">${fmt(r.recent.adr, 1)}</td><td class="n">${pct(r.recent.hs, 0)}</td><td class="n">${signed(r.recent.rating, 2)}</td>
      ${hasFaceit ? `<td class="n">${fmtInt(r.faceit.matches)}</td><td class="n">${wr(r.faceit.winrate)}</td><td class="n">${fmt(r.faceit.kd, 2)}</td>` : ""}</tr>`).join("")}
  </tbody></table>`;
}

function sourceTable(by) {
  const rows = Object.entries(by).sort((a, b) => b[1].matches - a[1].matches);
  if (!rows.length) return `<div class="empty">No matches.</div>`;
  return `<table><thead><tr><th>Platform</th><th class="n">Matches</th><th class="n">Win rate</th><th class="n">K/D</th><th class="n">ADR</th><th class="n">HS %</th><th class="n">Kills / round</th><th class="n">Leetify rating</th></tr></thead><tbody>
    ${rows.map(([k, a]) => `<tr><td><span class="src">${esc(k)}</span></td><td class="n">${a.matches}</td><td class="n">${pct(a.winrate, 0)}</td><td class="n">${fmt(a.kd, 2)}</td><td class="n">${fmt(a.adr, 1)}</td><td class="n">${pct(a.hs, 0)}</td><td class="n">${fmt(a.kpr, 2)}</td><td class="n">${signed(a.rating, 2)}</td></tr>`).join("")}
  </tbody></table>`;
}

/* --------------------------------------------------------- chart views --- */
function drawProgress(d) {
  const h = d.history || [], t = (s) => new Date(s.ts).getTime();
  const one = (name, key, color) => ({ name, color, values: h.map((s) => ({ x: t(s), y: s[key] })) });
  const c1 = css("--series-1"), c2 = css("--series-2"), c3 = css("--series-3");
  const cfg = {
    elo: { series: [one("FACEIT ELO", "faceit_elo", c1)], yFmt: (v) => fmt(v, 0) },
    premier: { series: [one("Premier", "premier", c1)], yFmt: (v) => fmtInt(v) },
    leetify: { series: [one("Leetify rating", "leetify_rating", c1)], yFmt: (v) => signed(v, 2) },
    skills: { series: [one("Aim", "aim", c1), one("Positioning", "positioning", c2), one("Utility", "utility", c3)], yFmt: (v) => fmt(v, 0) },
    kd: { series: [one("K/D (last 100)", "kd", c1)], yFmt: (v) => fmt(v, 2) },
    adr: { series: [one("ADR (last 100)", "adr", c1)], yFmt: (v) => fmt(v, 1) },
  }[state.progressTab];
  $("#progLegend").innerHTML = cfg.series.length > 1 ? `<div class="legend">${cfg.series.map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`).join("")}</div>` : "";
  const pts = cfg.series.flatMap((s) => s.values.filter((p) => p.y != null));
  if (pts.length < 2) {
    const first = h[0] ? dateLong(h[0].ts) : null;
    $("#progChart").innerHTML = `<div class="empty">${pts.length ? `First snapshot saved ${esc(first)}. Look this player up again after a few matches to start the progress line.` : "No data for this metric from the connected sources."}</div>`;
    return;
  }
  // delta since first snapshot
  const s0 = cfg.series[0].values.filter((p) => p.y != null);
  const ch = s0[s0.length - 1].y - s0[0].y;
  $("#progLegend").innerHTML += `<div class="legend"><span>${esc(cfg.series[0].name)}: <b class="${ch >= 0 ? "up" : "down"}">${ch >= 0 ? "+" : ""}${cfg.yFmt(ch)}</b> since ${dateShort(new Date(s0[0].x).toISOString())}</span></div>`;
  lineChart($("#progChart"), { series: cfg.series, yFmt: cfg.yFmt });
}

function drawPremier(d) {
  const lt = d.leetify;
  const pts = lt.available ? lt.rank_history.filter((r) => r.source === "premier" && r.rank > 1000) : [];
  if (pts.length < 2) { $("#premierChart").innerHTML = `<div class="empty">No recent Premier matches.</div>`; return; }
  lineChart($("#premierChart"), {
    series: [{ name: "Premier", color: css("--series-2"), values: pts.map((p) => ({ x: new Date(p.date).getTime(), y: p.rank })) }],
    yFmt: (v) => fmtInt(v),
  });
}

function drawForm(d) {
  const ms = d.matches.slice(0, 40).reverse();
  const k = state.formMetric;
  const get = { rating: (m) => m.rating, frating: faceitRating, kd: (m) => (m.deaths ? m.kills / m.deaths : m.kills), adr: (m) => m.adr, hs: (m) => m.hs_pct }[k];
  const ref = { rating: 0, frating: 1, kd: 1, adr: 80, hs: 45 }[k];
  const yf = { rating: (v) => signed(v, 1), frating: (v) => fmt(v, 2), kd: (v) => fmt(v, 2), adr: (v) => fmt(v, 0), hs: (v) => `${fmt(v, 0)}%` }[k];
  divergingBars($("#formChart"), {
    ref, yFmt: yf, rolling: 5,
    items: ms.map((m) => ({
      v: get(m),
      tip: `<div class="t">${esc(m.map)} · ${esc(m.score || "")} ${m.outcome ? `<span class="badge ${m.outcome}">${m.outcome[0].toUpperCase()}</span>` : ""}</div>
        ${tipRow("Date", dateLong(m.date))}${tipRow("Platform", m.source)}${tipRow("K / D / A", `${m.kills} / ${m.deaths} / ${m.assists}`)}
        ${tipRow("ADR", fmt(m.adr, 1))}${tipRow("HS %", pct(m.hs_pct, 0))}${m.rating != null ? tipRow("Leetify rating", signed(m.rating, 2)) : ""}${faceitRating(m) != null ? tipRow("FACEIT rating", fmt(faceitRating(m), 2)) : ""}`,
    })),
  });
}

const faceitRating = (m) => Analysis.faceitRating(m); // HLTV Rating 1.0 from FACEIT's stats

/** FACEIT matchroom for a FACEIT match (Leetify carries FACEIT's match id; FACEIT-only matches use it as their id). */
function roomUrl(m, d) {
  if (m.source !== "faceit" || d.demo) return null;
  const id = m.faceit_id || m.id;
  return id && /^1-[0-9a-f-]{36}$/i.test(id) ? `https://www.faceit.com/en/cs2/room/${encodeURIComponent(id)}` : null;
}

function drawMatches(d) {
  const f = state.filters, per = 20;
  const sources = [...new Set(d.matches.map((m) => m.source))].sort(), maps = [...new Set(d.matches.map((m) => m.map))].sort();
  const list = d.matches.filter((m) => (!f.source || m.source === f.source) && (!f.map || m.map === f.map) && (!f.outcome || m.outcome === f.outcome));
  const pages = Math.max(1, Math.ceil(list.length / per));
  state.histPage = Math.min(state.histPage, pages - 1);
  const rows = list.slice(state.histPage * per, state.histPage * per + per);
  const agg = summarize(list);
  const opt = (vals, cur, all) => `<option value="">${all}</option>` + vals.map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  $("#matchCard").innerHTML = `
    <div class="card-head" style="margin-bottom:10px"><div class="filters">
      <select data-f="source">${opt(sources, f.source, "All platforms")}</select>
      <select data-f="map">${opt(maps, f.map, "All maps")}</select>
      <select data-f="outcome">${opt(["win", "loss", "tie"], f.outcome, "All results")}</select></div>
      <div class="muted" style="font-size:12px">${list.length} matches · ${agg}</div></div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Platform</th><th>Map</th><th>Result</th><th class="n">Score</th><th class="n">K</th><th class="n">D</th><th class="n">A</th><th class="n">K/D</th><th class="n">ADR</th><th class="n">HS %</th><th class="n" title="Leetify rating – only for matches Leetify has analysed">Leetify rating</th><th class="n" title="HLTV Rating 1.0 calculated from FACEIT's match stats (FACEIT has no official per-match rating). 1.00 ≈ average.">FACEIT rating</th><th class="n">Rank</th><th>Matchroom</th></tr></thead><tbody>
    ${rows.map((m) => `<tr><td>${esc(dateLong(m.date))}</td><td><span class="src">${esc(m.source)}</span></td><td>${esc(m.map)}</td>
      <td>${m.outcome ? `<span class="badge ${m.outcome}">${m.outcome[0].toUpperCase()}</span>` : "–"}</td><td class="n">${esc(m.score || "–")}</td>
      <td class="n">${m.kills}</td><td class="n">${m.deaths}</td><td class="n">${m.assists}</td><td class="n">${fmt(m.deaths ? m.kills / m.deaths : m.kills, 2)}</td>
      <td class="n">${fmt(m.adr, 1)}</td><td class="n">${pct(m.hs_pct, 0)}</td><td class="n">${signed(m.rating, 2)}</td><td class="n">${fmt(faceitRating(m), 2)}</td><td class="n">${!m.rank ? "–" : m.source === "faceit" && m.rank <= 10 ? `Lvl ${m.rank}` : fmtInt(m.rank)}</td>
      <td>${roomUrl(m, d) ? `<a href="${esc(roomUrl(m, d))}" target="_blank" rel="noopener" title="Open the FACEIT matchroom">FACEIT ↗</a>` : `<span class="muted">–</span>`}</td></tr>`).join("") || `<tr><td colspan="15" class="empty">No matches for this filter.</td></tr>`}
    </tbody></table></div>
    <div class="pager"><button class="btn small" id="prevP" ${state.histPage === 0 ? "disabled" : ""}>← Newer</button><span>Page ${state.histPage + 1} of ${pages}</span><button class="btn small" id="nextP" ${state.histPage >= pages - 1 ? "disabled" : ""}>Older →</button></div>`;
  $("#matchCard").querySelectorAll("select").forEach((s) => (s.onchange = () => { state.filters[s.dataset.f] = s.value; state.histPage = 0; drawMatches(d); }));
  $("#prevP").onclick = () => { state.histPage--; drawMatches(d); };
  $("#nextP").onclick = () => { state.histPage++; drawMatches(d); };
}

function summarize(list) {
  if (!list.length) return "";
  const k = list.reduce((a, m) => a + m.kills, 0), dd = list.reduce((a, m) => a + m.deaths, 0);
  const dec = list.filter((m) => m.outcome === "win" || m.outcome === "loss");
  const w = dec.filter((m) => m.outcome === "win").length;
  const adr = list.filter((m) => m.adr != null);
  return `WR ${dec.length ? Math.round((100 * w) / dec.length) : "–"}% · K/D ${fmt(dd ? k / dd : k, 2)} · ADR ${adr.length ? fmt(adr.reduce((a, m) => a + m.adr, 0) / adr.length, 1) : "–"}`;
}

/* -------------------------------------------------------------- wiring --- */
$("#search").onsubmit = (e) => { e.preventDefault(); lookup($("#q").value.trim()); };
$("#demoBtn").onclick = () => lookup("demo");
$(".brand").style.cursor = "pointer";
$(".brand").onclick = () => { history.replaceState(null, "", location.pathname); $("#report").hidden = true; $("#error").hidden = true; $("#welcome").hidden = false; loadHome(); };
$("#settingsBtn").onclick = async () => {
  $("#faceitKey").value = ""; $("#leetifyKey").value = "";
  const cfg = await api("/api/config").catch(() => ({}));
  const browser = cfg.mode === "browser";
  $("#keysLocked").hidden = !cfg.locked; $("#keysLocal").hidden = !!cfg.locked || browser; $("#keysBrowser").hidden = !browser;
  $("#keyInputs").hidden = !!cfg.locked; $("#saveKeys").hidden = !!cfg.locked;
  $("#faceitKeyType").textContent = browser ? "new key (Server side works – it stays in this browser)" : "Server side";
  $("#historyTools").hidden = !browser;
  const pool = Analysis.getPool();
  $("#poolMaps").innerHTML = Analysis.KNOWN_MAPS.map((m) => `<label class="poolmap"><input type="checkbox" value="${esc(m)}" ${pool.includes(m) ? "checked" : ""}> ${esc(m)}</label>`).join("");
  $("#lockTools").hidden = !browser;
  $("#lockOut").hidden = true; $("#lockKeyInput").value = $("#lockPw1").value = $("#lockPw2").value = "";
  $("#settings").showModal();
};
/* sign in: unlock the site's password-locked FACEIT key in this browser */
function updateAuth(cfg) {
  $("#authBtn").hidden = !cfg.faceit_lock;
  $("#authBtn").textContent = cfg.signed_in ? "Sign out" : "Sign in";
  $("#authBtn").dataset.signedIn = cfg.signed_in ? "1" : "";
}
const refreshAfterAuth = () => { loadHome(); const q = new URLSearchParams(location.search).get("q"); if (q && !$("#report").hidden) lookup(q); };
$("#authBtn").onclick = () => {
  if ($("#authBtn").dataset.signedIn) { Engine.signOut(); refreshAfterAuth(); return; }
  $("#signinPw").value = ""; $("#signinErr").hidden = true; $("#signin").showModal(); $("#signinPw").focus();
};
$("#signinCancel").onclick = () => $("#signin").close();
$("#signinForm").onsubmit = async (e) => {
  e.preventDefault();
  $("#signinGo").disabled = true; $("#signinGo").textContent = "Checking…"; $("#signinErr").hidden = true;
  try {
    await Engine.unlock($("#signinPw").value, $("#signinRemember").checked);
    $("#signin").close(); refreshAfterAuth();
  } catch (err) { $("#signinErr").textContent = err.message; $("#signinErr").hidden = false; }
  finally { $("#signinGo").disabled = false; $("#signinGo").textContent = "Sign in"; $("#signinPw").value = ""; }
};
$("#lockBtn").onclick = async () => {
  const key = $("#lockKeyInput").value.trim(), p1 = $("#lockPw1").value, p2 = $("#lockPw2").value;
  if (!key) return alert("Paste the FACEIT key to lock.");
  if (p1.length < 14) return alert("Use a password of at least 14 characters – e.g. 4–5 random words.");
  if (p1 !== p2) return alert("The passwords don't match.");
  $("#lockBtn").disabled = true; $("#lockBtn").textContent = "Locking…";
  try {
    $("#lockResult").value = await Engine.lockKey(key, p1);
    $("#lockOut").hidden = false;
    $("#lockKeyInput").value = $("#lockPw1").value = $("#lockPw2").value = "";
  } finally { $("#lockBtn").disabled = false; $("#lockBtn").textContent = "Lock key"; }
};
$("#copyLock").onclick = async () => {
  try { await navigator.clipboard.writeText($("#lockResult").value); $("#copyLock").textContent = "Copied"; }
  catch { $("#lockResult").select(); $("#copyLock").textContent = "Press Ctrl+C"; }
  setTimeout(() => ($("#copyLock").textContent = "Copy"), 2000);
};
$("#poolReset").onclick = () => {
  const def = Analysis.DEFAULT_POOL;
  $("#poolMaps").querySelectorAll("input").forEach((i) => (i.checked = def.includes(i.value)));
};
$("#poolSave").onclick = () => {
  const picked = [...$("#poolMaps").querySelectorAll("input:checked")].map((i) => i.value);
  if (!picked.length) return alert("Pick at least one map.");
  Analysis.setPool(picked);
  try { localStorage.setItem(POOL_KEY, JSON.stringify(picked)); } catch {}
  $("#poolSave").textContent = "Saved"; setTimeout(() => ($("#poolSave").textContent = "Save map pool"), 1500);
  if (state.data && !$("#report").hidden) renderView();
};
$("#exportHistory").onclick = (e) => {
  e.preventDefault();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([Engine.exportHistory()], { type: "application/json" }));
  a.download = `cs2-tracker-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("#importFile").onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try { alert(`Imported ${Engine.importHistory(await f.text())} snapshots.`); $("#settings").close(); loadHome(); }
  catch (err) { alert(err.message); }
};
$("#saveKeys").onclick = async (e) => {
  e.preventDefault();
  const body = {};
  if ($("#faceitKey").value.trim()) body.faceit_api_key = $("#faceitKey").value.trim();
  if ($("#leetifyKey").value.trim()) body.leetify_api_key = $("#leetifyKey").value.trim();
  try { await api("/api/config", { method: "POST", body: JSON.stringify(body) }); }
  catch (err) { alert(err.message); return; }
  $("#settings").close(); loadHome();
};
let resizeT; addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => state.view && !$("#report").hidden && state.page === "summary" && (drawProgress(state.view), drawPremier(state.view), drawForm(state.view)), 150); });

loadHome();
const q0 = new URLSearchParams(location.search).get("q");
if (q0) lookup(q0);
