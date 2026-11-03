"use strict";
/* Pure player insights shared by the web app (app.js) and the Chrome extension: performance tiers,
 * strengths/weaknesses, current form, rank colours and inventory value. No DOM access. */

const fmtInt = (v) => (v == null ? "–" : Math.round(v).toLocaleString());
const signed = (v, d = 2) => (v == null ? "–" : (v > 0 ? "+" : "") + Number(v).toFixed(d));

/* ---------------------------------------------------- performance tiers --- */
const SCORE_TIERS = [[30, "Weak", "down"], [42, "Below average", "down"], [58, "Average", ""], [68, "Good", "up"], [78, "Very good", "up"], [88, "Elite", "up"], [Infinity, "Pro level", "up"]];
/** Plain-word tier for a 0-100 performance score. */
function scoreTier(v) { const [, name, tone] = SCORE_TIERS.find(([max]) => v < max); return { name, tone }; }

/* ------------------------------------------------- strengths & rank edge --- */
/** Each stat scored like the performance score (50 = average), for the Strong at / Weak at rows. */
function skillCandidates(d) {
  const r = d.leetify.available ? d.leetify.rating || {} : {}, o = d.overall || {}, c = [];
  const add = (label, raw, v, onlyGood) => { if (v != null && isFinite(v)) c.push({ label, raw, v, onlyGood }); };
  if (r.aim != null) add("Aim", `Leetify ${r.aim.toFixed(0)}`, r.aim);
  if (r.positioning != null) add("Positioning", `Leetify ${r.positioning.toFixed(0)}`, r.positioning);
  if (r.utility != null) add("Utility", `Leetify ${r.utility.toFixed(0)}`, r.utility);
  if (r.opening != null) add("Opening duels", `Leetify ${signed(r.opening, 1)}`, 50 + r.opening * 8);
  if (o.kd != null) add("Fragging", `K/D ${o.kd.toFixed(2)}`, 50 + (o.kd - 1) * 100);
  if (o.adr != null) add("Damage", `ADR ${o.adr.toFixed(0)}`, 50 + (o.adr - 77) * 2);
  if (o.hs != null) add("Headshots", `${Math.round(o.hs)}% HS`, 50 + (o.hs - 45) * 2.5);
  if (o.winrate != null && (o.matches || 0) >= 10) add("Winning games", `${Math.round(o.winrate)}% wins`, o.winrate * 1.25 - 12.5);
  if (r.ct != null && r.t != null && Math.abs(r.ct - r.t) >= 2.5) add(r.ct > r.t ? "CT side" : "T side", `Leetify ${signed(Math.max(r.ct, r.t), 1)} vs ${signed(Math.min(r.ct, r.t), 1)}`, 50 + Math.abs(r.ct - r.t) * 4, true);
  return c;
}
/** Clearly above average (65+), best first, up to 3. */
const strengths = (d) => skillCandidates(d).filter((x) => x.v >= 65).sort((a, b) => b.v - a.v).slice(0, 3);
/** Clearly below average (35 or less), worst first, up to 3. Side gaps only count as strengths. */
const weaknesses = (d) => skillCandidates(d).filter((x) => !x.onlyGood && x.v <= 35).sort((a, b) => a.v - b.v).slice(0, 3);

/** Current form: last 10 matches vs lifetime. FACEIT matches vs FACEIT lifetime when available (like for like),
 *  otherwise the last 10 vs the rest of the loaded history. Always uses every loaded match, not the platform/last-N filter. */
function currentForm(d) {
  const all = d.matches || [], life = d.faceit?.available ? d.faceit.lifetime || {} : {};
  const sumOf = (ms, f) => ms.reduce((a, m) => a + (f(m) || 0), 0);
  const stats = (ms) => {
    const dec = ms.filter((m) => m.outcome === "win" || m.outcome === "loss"), withAdr = ms.filter((m) => m.adr != null && m.rounds);
    const deaths = sumOf(ms, (m) => m.deaths);
    return { n: ms.length, wins: dec.filter((m) => m.outcome === "win").length, decided: dec.length,
      kd: deaths ? sumOf(ms, (m) => m.kills) / deaths : null,
      adr: withAdr.length ? sumOf(withAdr, (m) => m.adr * m.rounds) / sumOf(withAdr, (m) => m.rounds) : null,
      winrate: dec.length ? (100 * dec.filter((m) => m.outcome === "win").length) / dec.length : null };
  };
  const fms = all.filter((m) => m.source === "faceit");
  let recent, base, basis;
  if (life.kd != null && (life.matches || 0) >= 30 && fms.length >= 5) {
    recent = stats(fms.slice(0, 10)); base = { kd: life.kd, adr: life.adr, winrate: life.winrate }; basis = `last ${recent.n} FACEIT matches vs FACEIT lifetime (${fmtInt(life.matches)} matches)`;
  } else if (all.length >= 20) {
    recent = stats(all.slice(0, 10)); base = stats(all.slice(10)); basis = `last ${recent.n} matches vs the ${base.n} before`;
  } else return null;
  if (recent.kd == null || base.kd == null) return null;
  // each part in "clearly better/worse" units: K/D ±15%, ADR ±12%, win rate ±20 points
  const parts = [[(recent.kd - base.kd) / base.kd / 0.15, 0.45]];
  if (recent.adr != null && base.adr) parts.push([(recent.adr - base.adr) / base.adr / 0.12, 0.35]);
  if (recent.winrate != null && base.winrate != null) parts.push([(recent.winrate - base.winrate) / 20, 0.2]);
  const w = parts.reduce((a, [, x]) => a + x, 0), z = parts.reduce((a, [v, x]) => a + Math.max(-3, Math.min(3, v)) * x, 0) / w;
  const [label, tone] = z >= 1.6 ? ["🔥 On fire", "hot"] : z >= 0.8 ? ["Good form", "good"] : z <= -0.8 ? ["Poor form", "poor"] : ["Normal form", "normal"];
  const bits = [`K/D ${recent.kd.toFixed(2)} vs ${base.kd.toFixed(2)}`];
  if (recent.adr != null && base.adr) bits.push(`ADR ${Math.round(recent.adr)} vs ${Math.round(base.adr)}`);
  if (recent.decided) bits.push(`${recent.wins}–${recent.decided - recent.wins}${base.winrate != null ? ` (usually ${Math.round(base.winrate)}% wins)` : ""}`);
  return { label, tone, detail: bits.join(" · "), basis };
}

/* -------------------------------------------------------------- currency --- */
// The visitor's own currency: time zone first (a Danish user with an English browser is still in
// Copenhagen), then the browser language's region; USD when we have no rate for it.
const EURO_TZ = "Amsterdam Athens Berlin Bratislava Brussels Dublin Helsinki Lisbon Ljubljana Luxembourg Madrid Malta Monaco Paris Riga Rome Tallinn Vienna Vilnius Zagreb Nicosia".split(" ");
const TZ_CUR = { Copenhagen: "DKK", Stockholm: "SEK", Oslo: "NOK", London: "GBP", Zurich: "CHF", Warsaw: "PLN", Prague: "CZK", Budapest: "HUF",
  Bucharest: "RON", Reykjavik: "ISK", Istanbul: "TRY", Tokyo: "JPY", Seoul: "KRW", Shanghai: "CNY", Hong_Kong: "HKD", Singapore: "SGD",
  Kolkata: "INR", Jakarta: "IDR", Manila: "PHP", Bangkok: "THB", Kuala_Lumpur: "MYR", Jerusalem: "ILS", Johannesburg: "ZAR",
  Auckland: "NZD", Sao_Paulo: "BRL", Mexico_City: "MXN", Toronto: "CAD", Vancouver: "CAD", Edmonton: "CAD", Winnipeg: "CAD", Halifax: "CAD" };
const REGION_CUR = { DK: "DKK", SE: "SEK", NO: "NOK", GB: "GBP", CH: "CHF", PL: "PLN", CZ: "CZK", HU: "HUF", RO: "RON", IS: "ISK", TR: "TRY",
  JP: "JPY", KR: "KRW", CN: "CNY", HK: "HKD", SG: "SGD", IN: "INR", ID: "IDR", PH: "PHP", TH: "THB", MY: "MYR", IL: "ILS", ZA: "ZAR",
  AU: "AUD", NZ: "NZD", BR: "BRL", MX: "MXN", CA: "CAD", US: "USD",
  DE: "EUR", FR: "EUR", ES: "EUR", IT: "EUR", NL: "EUR", BE: "EUR", AT: "EUR", FI: "EUR", IE: "EUR", PT: "EUR", GR: "EUR", LU: "EUR",
  EE: "EUR", LV: "EUR", LT: "EUR", SK: "EUR", SI: "EUR", HR: "EUR", MT: "EUR", CY: "EUR" };
function localCurrency() {
  let tz = ""; try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch {}
  const [area, city = ""] = tz.split("/");
  if (TZ_CUR[city]) return TZ_CUR[city];
  if (area === "Europe" && EURO_TZ.includes(city)) return "EUR";
  if (area === "Australia") return "AUD";
  const region = (navigator.language || "").split("-")[1];
  return REGION_CUR[(region || "").toUpperCase()] || "USD";
}
/** An amount in USD shown in `fx` ({ cur, rate }), e.g. "kr 45,663". */
const moneyIn = (v, fx = { cur: "USD", rate: 1 }) => {
  const x = v * fx.rate;
  try { return new Intl.NumberFormat(navigator.language, { style: "currency", currency: fx.cur, currencyDisplay: "narrowSymbol", maximumFractionDigits: x >= 100 ? 0 : 2, minimumFractionDigits: x >= 100 ? 0 : 2 }).format(x); }
  catch { return `${fx.cur} ${Math.round(x).toLocaleString()}`; }
};

/** Prices an inventory ([{ name, count }]) with prices.json ({ prices, rates, updated }), in the viewer's currency. */
function valueInventory(items, pr) {
  const count = items.reduce((a, x) => a + x.count, 0);
  if (!pr || !pr.prices) return { count, priced: null };
  const cur = localCurrency(), rate = pr.rates && pr.rates[cur];
  const fx = rate ? { cur, rate } : { cur: "USD", rate: 1 };
  const priced = items.map((x) => ({ ...x, each: pr.prices[x.name] })).filter((x) => x.each != null)
    .map((x) => ({ ...x, total: x.each * x.count })).sort((a, b) => b.total - a.total);
  const total = priced.reduce((a, x) => a + x.total, 0);
  return { count, priced, total, fx, top: priced.slice(0, 5), pricedCount: priced.reduce((a, x) => a + x.count, 0), updated: pr.updated || null };
}

const FACEIT_LVL_COLORS = { 1: "#9aa0a6", 2: "#1ce400", 3: "#1ce400", 4: "#ffc800", 5: "#ffc800", 6: "#ffc800", 7: "#ffc800", 8: "#ff6309", 9: "#ff6309", 10: "#fe1f00" };
const PREMIER_COLORS = [[5000, "#b0c3d9"], [10000, "#8cc6ff"], [15000, "#6a7dff"], [20000, "#c166ff"], [25000, "#f03cff"], [30000, "#eb4b4b"], [Infinity, "#fed700"]];
/** Border for the player block: FACEIT level colours (one skill ladder for everyone), Premier tier colours if no FACEIT level.
 *  Weight grows with the level – low levels get a faint line, only the top gets a glow. */
function rankEdge(d) {
  const fc = d.faceit || {}, lt = d.leetify || {};
  const lvl = fc.available ? fc.level : lt.available ? lt.ranks.faceit : null;
  if (lvl) return { color: FACEIT_LVL_COLORS[Math.max(1, Math.min(10, lvl))], tier: lvl >= 10 ? "top" : lvl >= 8 ? "high" : lvl >= 4 ? "mid" : "low", why: `Border: FACEIT level ${lvl} colour` };
  const pr = lt.available ? lt.ranks.premier : null;
  if (pr) return { color: PREMIER_COLORS.find(([max]) => pr < max)[1], tier: pr >= 25000 ? "top" : pr >= 20000 ? "high" : pr >= 10000 ? "mid" : "low", why: `Border: Premier ${pr} tier colour (no FACEIT level)` };
  return null;
}
