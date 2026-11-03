/* CS2 inventory proxy – a Cloudflare Worker.
 *
 * Steam doesn't let other websites read inventories from a browser, so the tracker asks this
 * Worker instead: GET /inventory/<steam64> returns the player's CS2 items as a short list
 * [{ name, count, tradable }]. Only the tracker's own origins may call it, and each inventory is
 * cached for 10 minutes to stay clear of Steam's rate limits.
 *
 * Steam often throttles Cloudflare's shared addresses on steamcommunity.com. If the optional
 * secret STEAM_API_KEY is set (Worker -> Settings -> Variables and Secrets), the Worker falls
 * back to Steam's official Web API, which isn't throttled the same way.
 *
 * Deploy: Cloudflare dashboard -> Workers & Pages -> your Worker -> Edit code -> paste -> Deploy.
 * Diagnose: open <worker-url>/inventory/<steam64>?debug=1 to see what Steam answered.
 */
const ALLOWED = ["https://colandreasolling.github.io", "http://localhost:8765", "http://localhost:8766"];
const PAGE = 1000, MAX_PAGES = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** steamcommunity.com inventory endpoint (no key). Returns { status, assets, descriptions, tried }. */
async function community(id, tried) {
  const assets = [], descriptions = [];
  let start = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(`https://steamcommunity.com/inventory/${id}/730/2?l=english&count=${PAGE}${start ? `&start_assetid=${start}` : ""}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
          Accept: "application/json", Referer: `https://steamcommunity.com/profiles/${id}/inventory` } });
      tried.push(`community ${r.status}`);
      if (r.status !== 429) break;
      await sleep(800 * (attempt + 1));
    }
    if (r.status === 403) return { status: "private" };
    if (r.status === 429) return { status: "busy" };
    if (!r.ok) return { status: "error" };
    const data = await r.json();
    if (!data || !data.success) return { status: "private" };
    assets.push(...(data.assets || [])); descriptions.push(...(data.descriptions || []));
    if (!data.more_items || !data.last_assetid) break;
    start = data.last_assetid;
  }
  return { status: "ok", assets, descriptions };
}

/** Steam Web API (needs STEAM_API_KEY). */
async function webApi(id, key, tried) {
  const r = await fetch(`https://api.steampowered.com/IEconService/GetInventoryItemsWithDescriptions/v1/?key=${key}&steamid=${id}&appid=730&contextid=2&get_descriptions=true&language=english&count=5000`);
  tried.push(`webapi ${r.status}`);
  if (r.status === 403) return { status: "private" };
  if (!r.ok) return { status: r.status === 429 ? "busy" : "error" };
  const data = (await r.json()).response || {};
  if (!data.assets) return { status: "private" };
  return { status: "ok", assets: data.assets, descriptions: data.descriptions || [] };
}

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: "Origin" };
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": status === 200 ? "max-age=600" : "no-store" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (origin && !ALLOWED.includes(origin)) return json({ error: "origin not allowed" }, 403);
    const url = new URL(req.url), m = url.pathname.match(/^\/inventory\/(\d{17})$/);
    if (!m) return json({ error: "use /inventory/<steam64>" }, 404);
    const debug = url.searchParams.has("debug");

    const cacheKey = new Request(`https://cache.local/inventory/${m[1]}`);
    const hit = !debug && (await caches.default.match(cacheKey));
    if (hit) return json(await hit.json());

    const tried = [];
    let inv = await community(m[1], tried);
    if (inv.status === "busy" || inv.status === "error") {
      if (env.STEAM_API_KEY) inv = await webApi(m[1], env.STEAM_API_KEY, tried);
    }
    if (inv.status !== "ok") return json(debug ? { status: inv.status, tried } : { status: inv.status }, inv.status === "private" ? 200 : 503);

    const counts = new Map(), desc = new Map();
    for (const d of inv.descriptions) desc.set(`${d.classid}_${d.instanceid}`, d);
    for (const a of inv.assets) {
      const k = `${a.classid}_${a.instanceid}`;
      counts.set(k, (counts.get(k) || 0) + Number(a.amount || 1));
    }
    const items = [];
    for (const [k, n] of counts) {
      const d = desc.get(k);
      if (d && d.market_hash_name) items.push({ name: d.market_hash_name, count: n, tradable: !!d.tradable });
    }
    const body = { status: "ok", items, ...(debug ? { tried } : {}) };
    if (!debug) ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(body), { headers: { "Cache-Control": "max-age=600" } })));
    return json(body);
  },
};
