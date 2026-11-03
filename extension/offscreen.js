"use strict";
/* Answers the content script (via background.js): match room rosters, player cards, team map
 * comparisons and inventory values – all computed with the same engine and analysis as the site. */

const SITE = "https://colandreasolling.github.io/cs2-tracker-web/";
const TTL = 15 * 60_000, PRICES_TTL = 6 * 3600_000;
const players = new Map(), pending = new Map();

// at most 3 player lookups at a time (each is ~8 FACEIT + 2 Leetify calls in light mode)
let active = 0;
const queue = [];
const limit = (fn) => new Promise((res, rej) => { queue.push([fn, res, rej]); pump(); });
function pump() {
  while (active < 3 && queue.length) {
    const [fn, res, rej] = queue.shift();
    active++;
    fn().then(res, rej).finally(() => { active--; pump(); });
  }
}

/** Full player summary (light mode: no per-match half scores), cached for 15 minutes. */
function player(q) {
  const hit = players.get(q);
  if (hit && Date.now() - hit.at < TTL) return Promise.resolve(hit.d);
  if (!pending.has(q)) {
    pending.set(q, limit(() => Engine.handle(`/api/player?q=${encodeURIComponent(q)}&snap=0&light=1`))
      .then((d) => { players.set(q, { at: Date.now(), d }); return d; })
      .finally(() => pending.delete(q)));
  }
  return pending.get(q);
}

const mapName = (s) => String(s || "").replace(/^(de|cs)_/i, "").replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

/** The match room: both rosters and the map pool being vetoed. */
async function room(matchId) {
  if (!Engine.hasFaceitKey()) return { error: "nokey" };
  const m = await Engine.faceitGet(`/matches/${matchId}`);
  const side = (f) => ({
    name: f?.name || "",
    players: (f?.roster || []).map((p) => ({ id: p.player_id, nick: p.nickname, steam64: p.game_player_id || null, avatar: p.avatar || null, level: p.game_skill_level ?? null })),
  });
  const ent = m.voting?.map?.entities || [];
  return {
    id: matchId, status: m.status || null,
    teams: { faction1: side(m.teams?.faction1), faction2: side(m.teams?.faction2) },
    pool: ent.map((e) => mapName(e.game_map_id || e.class_name || e.name)).filter(Boolean),
    picked: (m.voting?.map?.pick || []).map(mapName),
  };
}

/** Everything a hover card shows, small enough to message. */
function card(d) {
  const fc = d.faceit || {}, lt = d.leetify || {}, o = d.overall || {};
  let r = {}, integ = {};
  try { r = Analysis.role(d); } catch {}
  try { integ = Analysis.integrity(d); } catch {}
  return {
    steam64: d.steam64, name: d.identity?.name, avatar: d.identity?.avatar || null, country: d.identity?.country || null,
    level: fc.available ? fc.level : lt.ranks?.faceit ?? null, elo: fc.available ? fc.elo : lt.ranks?.faceit_elo ?? null,
    premier: lt.available ? lt.ranks?.premier ?? null : null, leetify: lt.available ? lt.ranks?.leetify ?? null : null,
    edge: rankEdge(d), score: d.score ?? null, tier: d.score != null ? scoreTier(d.score) : null,
    role: r.available ? { name: r.primary?.name, secondary: r.secondary?.name || null, confidence: r.confidence } : null,
    aggression: r.aggression ? { score: r.aggression.score, label: r.aggression.label, low: !!r.aggression.lowConfidence, tone: r.aggression.tone } : null,
    tags: (r.tags || []).map((t) => ({ name: t.name, tone: t.tone, mate: t.mate, opp: t.opp })),
    form: currentForm(d), strengths: strengths(d), weaknesses: weaknesses(d),
    stats: { lifetime: fc.available ? fc.lifetime?.matches ?? null : lt.total_matches ?? null, kd: o.kd, adr: o.adr, hs: o.hs, winrate: o.winrate, recent: o.matches },
    integrity: integ.available && ["high", "flag"].includes(integ.level) ? { level: integ.level, verdict: integ.verdict } : null,
    missing: [!fc.available && "FACEIT", !lt.available && "Leetify"].filter(Boolean),
    url: `${SITE}?q=${d.steam64}`,
  };
}

/** One side's maps (Analysis.team: shrunk win rates per map) and line-up insights. */
async function team(ids, pool) {
  const ds = (await Promise.all(ids.map((q) => player(q).catch(() => null)))).filter(Boolean);
  if (!ds.length) return { n: 0 };
  Analysis.setPool(pool && pool.length ? pool : null);
  const t = Analysis.team(ds.map((d) => ({ d })));
  return {
    n: ds.length,
    maps: t.maps.map((m) => ({ map: m.map, score: m.score, comfort: m.comfort, unplayed: m.unplayed, weakest: m.weakest,
      games: m.cells.reduce((a, c) => a + (c.n || 0), 0) })),
    insights: { strengths: t.insights.strengths, weaknesses: t.insights.weaknesses },
    together: t.together && t.together.n ? { n: t.together.n, winrate: t.together.winrate } : null,
  };
}

/* ------------------------------------------------------------ inventory --- */
let prices = null;
async function loadPrices() {
  if (prices && Date.now() - prices.at < PRICES_TTL) return prices.data;
  const data = await fetch(`${SITE}prices.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (data) prices = { at: Date.now(), data };
  return data;
}
const invCache = new Map();
async function inventory(id) {
  const hit = invCache.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.v;
  const counts = new Map(), desc = new Map();
  let start = "";
  for (let page = 0; page < 3; page++) {
    const r = await fetch(`https://steamcommunity.com/inventory/${id}/730/2?l=english&count=1000${start ? `&start_assetid=${start}` : ""}`);
    if (r.status === 403) return { status: "private" };
    if (r.status === 429) return { status: "busy" };
    if (!r.ok) return { status: "error" };
    const data = await r.json();
    if (!data || !data.success) return { status: "private" };
    for (const d of data.descriptions || []) desc.set(`${d.classid}_${d.instanceid}`, d);
    for (const a of data.assets || []) { const k = `${a.classid}_${a.instanceid}`; counts.set(k, (counts.get(k) || 0) + Number(a.amount || 1)); }
    if (!data.more_items || !data.last_assetid) break;
    start = data.last_assetid;
  }
  const items = [];
  for (const [k, n] of counts) { const d = desc.get(k); if (d?.market_hash_name) items.push({ name: d.market_hash_name, count: n }); }
  const v = valueInventory(items, await loadPrices());
  const out = !v.priced ? { status: "ok", count: v.count }
    : { status: "ok", count: v.count, total: moneyIn(v.total, v.fx), usd: v.total, rich: v.total >= 1000,
      top: v.top.map((x) => ({ name: x.name, count: x.count, price: moneyIn(x.total, v.fx) })), updated: v.updated, cur: v.fx.cur };
  invCache.set(id, { at: Date.now(), v: out });
  return out;
}

/* ------------------------------------------------------------- messages --- */
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.target !== "offscreen") return false;
  const handlers = {
    status: () => ({ hasKey: Engine.hasFaceitKey() }),
    room: () => room(msg.matchId),
    card: () => player(msg.q).then(card),
    team: () => team(msg.ids || [], msg.pool),
    inventory: () => inventory(msg.steam64),
  };
  const fn = handlers[msg.type];
  if (!fn) { reply({ error: "unknown request" }); return false; }
  Promise.resolve().then(fn).then(reply, (e) => reply({ error: String(e?.message || e), status: e?.status ?? null }));
  return true;
});
