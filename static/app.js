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

let state = { data: null, progressTab: "elo", formMetric: "rating", page: 0, filters: { source: "", map: "", outcome: "" } };

/* ------------------------------------------------------------- theme --- */
try { const t = localStorage.getItem("theme"); if (t) document.documentElement.dataset.theme = t; } catch {}
$("#themeBtn").onclick = () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark"
    : matchMedia("(prefers-color-scheme: dark)").matches;
  document.documentElement.dataset.theme = dark ? "light" : "dark";
  try { localStorage.setItem("theme", document.documentElement.dataset.theme); } catch {}
  if (state.data) render(state.data);
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
  $("#keyStatus").innerHTML = pill(cfg.faceit, "FACEIT", "no key – FACEIT data disabled", cfg.faceit_builtin ? "built-in key" : "key set") + pill(cfg.leetify, "Leetify", "no key – works, lower rate limit");
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

async function lookup(q) {
  if (!q) return;
  $("#q").value = q === "demo" ? "" : q;
  $("#welcome").hidden = true; $("#report").hidden = true; $("#error").hidden = true; $("#loading").hidden = false;
  history.replaceState(null, "", "?q=" + encodeURIComponent(q));
  try {
    const d = await api("/api/player?q=" + encodeURIComponent(q));
    state = { ...state, data: d, page: 0, filters: { source: "", map: "", outcome: "" } };
    render(d);
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

  const html = `
  ${notices.length ? `<div class="notice">${notices.join("<br>")}</div>` : ""}
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
      <div class="ranks">${ranks.map(([k, v]) => `<div class="rank"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join("")}</div>
      ${comp && comp.length ? `<div class="muted" style="margin-top:8px;font-size:12px">Competitive map ranks: ${comp.map((c) => `${esc(c.map)} ${c.rank}`).join(" · ")}</div>` : ""}
      ${lt.available && lt.bans && lt.bans.length ? `<div class="down" style="margin-top:8px;font-size:12px">⚠ Platform bans on record: ${lt.bans.map((b) => esc(b.platform)).join(", ")}</div>` : ""}
    </div>
    <div class="score" title="Composite of Leetify aim/positioning/utility, K/D, ADR, Leetify rating and win rate. 50 ≈ average.">
      <div class="score-ring">
        <svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="52" fill="none" stroke="${css("--surface-2")}" stroke-width="10"/>
        <circle cx="60" cy="60" r="52" fill="none" stroke="${css("--accent")}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${ringFill} ${ringC}" transform="rotate(-90 60 60)"/></svg>
        <div class="num">${score ?? "–"}</div>
      </div>
      <div class="lbl">Performance score / 100</div>
    </div>
  </div>

  <div class="section-title">Last ${o.matches || 0} matches · all platforms</div>
  <div class="kpis">
    ${kpi("Win rate", pct(o.winrate), delta(f10.winrate, prev.winrate, 1))}
    ${kpi("K/D", fmt(o.kd, 2), delta(f10.kd, prev.kd, 2))}
    ${kpi("ADR", fmt(o.adr, 1), delta(f10.adr, prev.adr, 1))}
    ${kpi("Headshot %", pct(o.hs), delta(f10.hs, prev.hs, 1))}
    ${kpi("Kills / round", fmt(o.kpr, 2), delta(f10.kpr, prev.kpr, 2))}
    ${kpi("Leetify rating", signed(o.rating, 2), delta(f10.rating, prev.rating, 2))}
    ${kpi("3K+ per match", fmt(o.mk3plus_per_match, 2), delta(f10.mk3plus_per_match, prev.mk3plus_per_match, 2))}
    ${kpi("Streak", d.streaks.current ? `${d.streaks.current}${d.streaks.current_type === "win" ? "W" : "L"}` : "–", `<span class="muted">best ${d.streaks.longest_win}W · worst ${d.streaks.longest_loss}L</span>`)}
  </div>

  <div class="grid g2">
    <div class="card"><h2>Strengths</h2><div class="sub">Compared with rough rule-of-thumb reference values</div>${insightList(d.insights.filter((i) => i.type === "strength"), true)}</div>
    <div class="card"><h2>Areas to improve</h2><div class="sub">Compared with rough rule-of-thumb reference values</div>${insightList(d.insights.filter((i) => i.type === "weakness"), false)}</div>
  </div>

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
      <div class="tabs" id="formTabs">${[["rating", "Leetify rating"], ["kd", "K/D"], ["adr", "ADR"], ["hs", "HS %"]].map(([k, l]) => `<button data-k="${k}" class="${state.formMetric === k ? "on" : ""}">${l}</button>`).join("")}</div></div>
    <div class="chart" id="formChart"></div>
  </div>

  <div class="section-title">Skill profile (Leetify)</div>
  ${lt.available ? skillSection(lt) : `<div class="card empty">Leetify data unavailable – ${esc(lt.reason)}</div>`}

  <div class="section-title">FACEIT</div>
  ${fc.available ? faceitSection(fc) : `<div class="card empty">FACEIT data unavailable – ${esc(fc.reason)}</div>`}

  <div class="section-title">Map pool</div>
  <div class="card table-wrap" style="margin-bottom:16px">${mapTable(d.map_pool, fc.available)}</div>

  <div class="section-title">By platform</div>
  <div class="card table-wrap" style="margin-bottom:16px">${sourceTable(d.by_source)}</div>

  <div class="section-title">Match history</div>
  <div class="card" id="matchCard"></div>
  <p class="muted" style="font-size:12px;margin-top:20px">Data: FACEIT Data API v4 and Leetify Public CS API. Leetify covers Premier, competitive, FACEIT and other sources that it has parsed; FACEIT-only matches Leetify hasn't parsed are added from FACEIT. Ratings and reference thresholds are indicative, not official.</p>`;

  $("#report").innerHTML = html;
  $("#report").hidden = false;
  $("#welcome").hidden = true;

  $("#progTabs").onclick = (e) => { const k = e.target.dataset.k; if (!k) return; state.progressTab = k; $("#progTabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k)); drawProgress(d); };
  $("#formTabs").onclick = (e) => { const k = e.target.dataset.k; if (!k) return; state.formMetric = k; $("#formTabs").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k)); drawForm(d); };
  drawProgress(d); drawPremier(d); drawForm(d); drawMatches(d);
}

const kpi = (k, v, dl) => `<div class="card kpi"><div class="k">${esc(k)}</div><div class="v">${v}</div><div class="d">${dl || "&nbsp;"}</div></div>`;

function insightList(items, good) {
  if (!items.length) return `<div class="empty">Nothing stands out ${good ? "above" : "below"} the reference values.</div>`;
  const col = good ? css("--good") : css("--bad");
  return `<ul class="ins-list">${items.map((i) => `<li><span class="ic" style="background:${col}" aria-label="${good ? "strength" : "weakness"}">${good ? "+" : "−"}</span>
    <span>${esc(i.label)}<span class="ref">${esc(i.ref)}</span></span><span class="val">${esc(fmtVal(i.value))}${esc(i.unit)}</span></li>`).join("")}</ul>`;
}
const fmtVal = (v) => (Math.abs(v) >= 100 ? Math.round(v) : Math.abs(v) < 1 ? v.toFixed(2) : v.toFixed(1));

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
  const get = { rating: (m) => m.rating, kd: (m) => (m.deaths ? m.kills / m.deaths : m.kills), adr: (m) => m.adr, hs: (m) => m.hs_pct }[k];
  const ref = { rating: 0, kd: 1, adr: 80, hs: 45 }[k];
  const yf = { rating: (v) => signed(v, 1), kd: (v) => fmt(v, 2), adr: (v) => fmt(v, 0), hs: (v) => `${fmt(v, 0)}%` }[k];
  divergingBars($("#formChart"), {
    ref, yFmt: yf, rolling: 5,
    items: ms.map((m) => ({
      v: get(m),
      tip: `<div class="t">${esc(m.map)} · ${esc(m.score || "")} ${m.outcome ? `<span class="badge ${m.outcome}">${m.outcome[0].toUpperCase()}</span>` : ""}</div>
        ${tipRow("Date", dateLong(m.date))}${tipRow("Platform", m.source)}${tipRow("K / D / A", `${m.kills} / ${m.deaths} / ${m.assists}`)}
        ${tipRow("ADR", fmt(m.adr, 1))}${tipRow("HS %", pct(m.hs_pct, 0))}${m.rating != null ? tipRow("Leetify rating", signed(m.rating, 2)) : ""}`,
    })),
  });
}

function drawMatches(d) {
  const f = state.filters, per = 20;
  const sources = [...new Set(d.matches.map((m) => m.source))].sort(), maps = [...new Set(d.matches.map((m) => m.map))].sort();
  const list = d.matches.filter((m) => (!f.source || m.source === f.source) && (!f.map || m.map === f.map) && (!f.outcome || m.outcome === f.outcome));
  const pages = Math.max(1, Math.ceil(list.length / per));
  state.page = Math.min(state.page, pages - 1);
  const rows = list.slice(state.page * per, state.page * per + per);
  const agg = summarize(list);
  const opt = (vals, cur, all) => `<option value="">${all}</option>` + vals.map((v) => `<option ${v === cur ? "selected" : ""}>${esc(v)}</option>`).join("");
  $("#matchCard").innerHTML = `
    <div class="card-head" style="margin-bottom:10px"><div class="filters">
      <select data-f="source">${opt(sources, f.source, "All platforms")}</select>
      <select data-f="map">${opt(maps, f.map, "All maps")}</select>
      <select data-f="outcome">${opt(["win", "loss", "tie"], f.outcome, "All results")}</select></div>
      <div class="muted" style="font-size:12px">${list.length} matches · ${agg}</div></div>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Platform</th><th>Map</th><th>Result</th><th class="n">Score</th><th class="n">K</th><th class="n">D</th><th class="n">A</th><th class="n">K/D</th><th class="n">ADR</th><th class="n">HS %</th><th class="n">Rating</th><th class="n">Rank</th></tr></thead><tbody>
    ${rows.map((m) => `<tr><td>${esc(dateLong(m.date))}</td><td><span class="src">${esc(m.source)}</span></td><td>${esc(m.map)}</td>
      <td>${m.outcome ? `<span class="badge ${m.outcome}">${m.outcome[0].toUpperCase()}</span>` : "–"}</td><td class="n">${esc(m.score || "–")}</td>
      <td class="n">${m.kills}</td><td class="n">${m.deaths}</td><td class="n">${m.assists}</td><td class="n">${fmt(m.deaths ? m.kills / m.deaths : m.kills, 2)}</td>
      <td class="n">${fmt(m.adr, 1)}</td><td class="n">${pct(m.hs_pct, 0)}</td><td class="n">${signed(m.rating, 2)}</td><td class="n">${!m.rank ? "–" : m.source === "faceit" && m.rank <= 10 ? `Lvl ${m.rank}` : fmtInt(m.rank)}</td></tr>`).join("") || `<tr><td colspan="13" class="empty">No matches for this filter.</td></tr>`}
    </tbody></table></div>
    <div class="pager"><button class="btn small" id="prevP" ${state.page === 0 ? "disabled" : ""}>← Newer</button><span>Page ${state.page + 1} of ${pages}</span><button class="btn small" id="nextP" ${state.page >= pages - 1 ? "disabled" : ""}>Older →</button></div>`;
  $("#matchCard").querySelectorAll("select").forEach((s) => (s.onchange = () => { state.filters[s.dataset.f] = s.value; state.page = 0; drawMatches(d); }));
  $("#prevP").onclick = () => { state.page--; drawMatches(d); };
  $("#nextP").onclick = () => { state.page++; drawMatches(d); };
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
  $("#settings").showModal();
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
let resizeT; addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => state.data && !$("#report").hidden && (drawProgress(state.data), drawPremier(state.data), drawForm(state.data)), 150); });

loadHome();
const q0 = new URLSearchParams(location.search).get("q");
if (q0) lookup(q0);
