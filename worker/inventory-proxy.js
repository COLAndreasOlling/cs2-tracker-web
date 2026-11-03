/* CS2 inventory proxy – a Cloudflare Worker.
 *
 * Steam doesn't let other websites read inventories from a browser, so the tracker asks this
 * Worker instead: GET /inventory/<steam64> returns the player's CS2 items as a short list
 * [{ name, count, icon }]. No secrets; only the tracker's own origins may call it, and each
 * inventory is cached for 10 minutes to stay clear of Steam's rate limits.
 *
 * Deploy: Cloudflare dashboard -> Workers & Pages -> Create Worker -> Edit code -> paste -> Deploy.
 */
const ALLOWED = ["https://colandreasolling.github.io", "http://localhost:8765", "http://localhost:8766"];
const PAGE = 2000, MAX_PAGES = 3;

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin") || "";
    const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: "Origin" };
    const json = (body, status = 200) => new Response(JSON.stringify(body), {
      status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": "max-age=600" } });

    if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
    if (origin && !ALLOWED.includes(origin)) return json({ error: "origin not allowed" }, 403);
    const m = new URL(req.url).pathname.match(/^\/inventory\/(\d{17})$/);
    if (!m) return json({ error: "use /inventory/<steam64>" }, 404);

    const cacheKey = new Request(`https://cache.local/inventory/${m[1]}`);
    const hit = await caches.default.match(cacheKey);
    if (hit) return json(await hit.json());

    const counts = new Map(), desc = new Map();
    let start = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await fetch(`https://steamcommunity.com/inventory/${m[1]}/730/2?l=english&count=${PAGE}${start ? `&start_assetid=${start}` : ""}`,
        { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } });
      if (r.status === 403) return json({ status: "private" });
      if (r.status === 429) return json({ status: "busy" }, 503);
      if (!r.ok) return json({ status: "error", code: r.status }, 502);
      const data = await r.json();
      if (!data || !data.success) return json({ status: "private" });
      for (const d of data.descriptions || []) desc.set(`${d.classid}_${d.instanceid}`, d);
      for (const a of data.assets || []) {
        const k = `${a.classid}_${a.instanceid}`;
        counts.set(k, (counts.get(k) || 0) + Number(a.amount || 1));
      }
      if (!data.more_items || !data.last_assetid) break;
      start = data.last_assetid;
    }

    const items = [];
    for (const [k, n] of counts) {
      const d = desc.get(k);
      if (d && d.market_hash_name) items.push({ name: d.market_hash_name, count: n, icon: d.icon_url || "", tradable: !!d.tradable });
    }
    const body = { status: "ok", items };
    ctx.waitUntil(caches.default.put(cacheKey, new Response(JSON.stringify(body), { headers: { "Cache-Control": "max-age=600" } })));
    return json(body);
  },
};
