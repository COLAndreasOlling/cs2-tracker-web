/* CS2 inventory proxy for Deno Deploy (Steam throttles Cloudflare Workers, but not other hosts).
 *
 * GET /inventory/<steam64> returns the player's CS2 items as [{ name, count, tradable }].
 * No secrets. Only the tracker's own origins may call it; each inventory is cached for
 * 10 minutes and each visitor is limited to 20 lookups a minute.
 *
 * Deploy: dash.deno.com -> New Playground (or New Project) -> paste this file -> Save & Deploy.
 * Diagnose: open <url>/inventory/<steam64>?debug=1 to see what Steam answered.
 */
const ALLOWED = ["https://colandreasolling.github.io", "http://localhost:8765", "http://localhost:8766"];
const PAGE = 1000, MAX_PAGES = 5, TTL = 10 * 60_000, PER_MINUTE = 20;
const cache = new Map<string, { at: number; body: unknown }>();
const hits = new Map<string, number[]>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// deno-lint-ignore no-explicit-any
async function community(id: string, tried: string[]): Promise<{ status: string; assets?: any[]; descriptions?: any[] }> {
  const assets = [], descriptions = [];
  let start = "";
  for (let page = 0; page < MAX_PAGES; page++) {
    let r!: Response;
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

Deno.serve(async (req, info) => {
  const origin = req.headers.get("Origin") || "";
  const cors = { "Access-Control-Allow-Origin": ALLOWED.includes(origin) ? origin : ALLOWED[0], Vary: "Origin" };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status, headers: { ...cors, "Content-Type": "application/json", "Cache-Control": status === 200 ? "max-age=600" : "no-store" } });

  if (req.method === "OPTIONS") return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET" } });
  if (origin && !ALLOWED.includes(origin)) return json({ error: "origin not allowed" }, 403);
  const url = new URL(req.url), m = url.pathname.match(/^\/inventory\/(\d{17})$/);
  if (!m) return json({ error: "use /inventory/<steam64>" }, 404);
  const debug = url.searchParams.has("debug");

  // per-visitor rate limit
  const ip = (info.remoteAddr as Deno.NetAddr).hostname, now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_MINUTE) return json({ status: "busy" }, 429);
  hits.set(ip, [...recent, now]);

  const hit = cache.get(m[1]);
  if (!debug && hit && now - hit.at < TTL) return json(hit.body);

  const tried: string[] = [];
  const inv = await community(m[1], tried);
  if (inv.status !== "ok") return json(debug ? { status: inv.status, tried } : { status: inv.status }, inv.status === "private" ? 200 : 503);

  const counts = new Map<string, number>(), desc = new Map<string, { market_hash_name?: string; tradable?: number }>();
  for (const d of inv.descriptions!) desc.set(`${d.classid}_${d.instanceid}`, d);
  for (const a of inv.assets!) {
    const k = `${a.classid}_${a.instanceid}`;
    counts.set(k, (counts.get(k) || 0) + Number(a.amount || 1));
  }
  const items = [];
  for (const [k, n] of counts) {
    const d = desc.get(k);
    if (d && d.market_hash_name) items.push({ name: d.market_hash_name, count: n, tradable: !!d.tradable });
  }
  const body = { status: "ok", items };
  if (cache.size > 500) cache.clear();
  cache.set(m[1], { at: now, body });
  return json(debug ? { ...body, tried } : body);
});
