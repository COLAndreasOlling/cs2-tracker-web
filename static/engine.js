/* CS2 Tracker - in-browser engine.
 *
 * A JavaScript port of server.py used when the page is served without the
 * Python server (e.g. GitHub Pages). It calls FACEIT and Leetify directly from
 * the browser and keeps API keys and progress snapshots in localStorage, so
 * history is per browser. The JSON it returns matches the server's API.
 */
"use strict";

const Engine = (() => {
  const FACEIT_BASE = "https://open.faceit.com/data/v4";
  const LEETIFY_BASE = "https://api-public.cs-prod.leetify.com";
  const STEAM64_RE = /7656119\d{10}/;
  const CACHE_TTL = 120000;
  const CFG_KEY = "cs2tracker.config";
  const SNAP_KEY = "cs2tracker.snapshots";
  const cache = new Map();

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }

  /* ------------------------------------------------------------ storage --- */
  const readJSON = (k, dflt) => { try { return JSON.parse(localStorage.getItem(k)) ?? dflt; } catch { return dflt; } };
  const writeJSON = (k, v) => {
    try { localStorage.setItem(k, JSON.stringify(v)); }
    catch { throw new ApiError(500, "This browser blocked local storage, so keys and history can't be saved."); }
  };
  const SITE_FACEIT_KEY = (window.CS2_CONFIG && window.CS2_CONFIG.faceitApiKey) || "";
  const SITE_LOCKED_KEY = (window.CS2_CONFIG && window.CS2_CONFIG.faceitKeyLocked) || "";
  const UNLOCKED_KEY = "cs2tracker.unlocked";
  const storedConfig = () => ({ faceit_api_key: "", leetify_api_key: "", ...readJSON(CFG_KEY, {}) });
  // the key unlocked by signing in lives in localStorage ("remember") or sessionStorage (this tab only)
  const unlockedKey = () => {
    for (const s of [localStorage, sessionStorage]) { try { const k = s.getItem(UNLOCKED_KEY); if (k) return k; } catch {} }
    return "";
  };
  // a key saved in this browser wins, then a signed-in (unlocked) key, then the site's built-in client key
  const loadConfig = () => { const c = storedConfig(); return { ...c, faceit_api_key: c.faceit_api_key || unlockedKey() || SITE_FACEIT_KEY }; };
  const allSnapshots = () => readJSON(SNAP_KEY, {});

  /* ------------------------------------------------- password-locked key --- */
  // The site can carry a FACEIT key encrypted with a password (AES-256-GCM, key derived with
  // PBKDF2-SHA256). Only someone who knows the password can decrypt and use it.
  const LOCK_PREFIX = "cs2k1.";
  const PBKDF2_ROUNDS = 600000;
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

  async function deriveKey(password, salt, rounds) {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: rounds, hash: "SHA-256" }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function lockKey(apiKey, password) {
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const aes = await deriveKey(password, salt, PBKDF2_ROUNDS);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(apiKey.trim()));
    return LOCK_PREFIX + btoa(JSON.stringify({ n: PBKDF2_ROUNDS, s: b64(salt), i: b64(iv), c: b64(ct) }));
  }

  async function unlock(password, remember) {
    if (!SITE_LOCKED_KEY.startsWith(LOCK_PREFIX)) throw new Error("This site has no locked FACEIT key.");
    let p;
    try { p = JSON.parse(atob(SITE_LOCKED_KEY.slice(LOCK_PREFIX.length))); }
    catch { throw new Error("The site's locked key is damaged – lock it again and update the FACEIT_KEY_LOCKED secret."); }
    let key;
    try {
      const aes = await deriveKey(password, unb64(p.s), p.n);
      key = new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(p.i) }, aes, unb64(p.c)));
    } catch { throw new Error("Wrong password."); }
    signOut();
    try { (remember ? localStorage : sessionStorage).setItem(UNLOCKED_KEY, key); }
    catch { throw new Error("This browser blocked storage, so the sign-in can't be kept."); }
    cache.clear();
  }

  function signOut() {
    for (const s of [localStorage, sessionStorage]) { try { s.removeItem(UNLOCKED_KEY); } catch {} }
    cache.clear();
  }

  /* --------------------------------------------------------------- http --- */
  async function httpGet(url, headers = {}) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;
    let r;
    try { r = await fetch(url, { headers }); }
    catch (e) { throw new ApiError(0, `Network error reaching ${new URL(url).host}`); }
    if (!r.ok) throw new ApiError(r.status, `HTTP ${r.status} from ${new URL(url).host}`);
    const data = await r.json();
    cache.set(url, { t: Date.now(), data });
    return data;
  }
  const qs = (p) => (p && Object.keys(p).length ? "?" + new URLSearchParams(p) : "");
  const faceitGet = (path, key, params) => httpGet(FACEIT_BASE + path + qs(params), { Authorization: `Bearer ${key}` });
  const leetifyGet = (path, key, params) => httpGet(LEETIFY_BASE + path + qs(params), key ? { _leetify_key: key } : {});

  /* ------------------------------------------------------------ helpers --- */
  const num = (v, dflt = null) => {
    if (v == null || v === "") return dflt;
    const f = parseFloat(String(v).replace(/,/g, "").replace("%", ""));
    return Number.isNaN(f) ? dflt : f;
  };
  const pick = (d, ...keys) => { for (const k of keys) if (d && d[k] != null && d[k] !== "") return d[k]; return null; };
  const safeDiv = (a, b) => (b ? a / b : null);
  const mean = (xs) => { const v = xs.filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const roundOr = (v, nd = 2) => (v == null ? null : Math.round(v * 10 ** nd) / 10 ** nd);
  const mapKey = (name) => {
    if (!name) return "Unknown";
    const n = String(name).trim().toLowerCase().replace(/^(de|cs|ar|dz)_/, "").replace(/_/g, " ");
    return n.replace(/\b\w/g, (c) => c.toUpperCase());
  };
  const iso = (ts) => {
    if (ts == null) return null;
    if (typeof ts === "number" || /^\d+$/.test(String(ts))) {
      let t = Number(ts); if (t < 1e12) t *= 1000;
      return new Date(t).toISOString();
    }
    return String(ts);
  };
  const nowIso = () => new Date().toISOString();

  /* ---------------------------------------------------------- resolving --- */
  function resolveQuery(q, cfg) {
    q = q.trim();
    let m = q.match(STEAM64_RE);
    if (m) return { steam64: m[0], faceit_nickname: null };
    m = q.match(/faceit\.com\/(?:[a-z-]+\/)?players\/([^/?#]+)/i);
    if (m) return { steam64: null, faceit_nickname: decodeURIComponent(m[1]) };
    if (/steamcommunity\.com\/id\//i.test(q))
      throw new ApiError(400, "Custom Steam URLs (/id/name) can't be resolved in the web version. Use the Steam64 ID (the 7656119… number), e.g. from steamid.io, or a FACEIT nickname.");
    if (cfg.faceit_api_key) return { steam64: null, faceit_nickname: q.replace(/^@/, "") };
    if (SITE_LOCKED_KEY) throw new ApiError(401, "Sign in (top right) to search by FACEIT nickname. Without signing in, search by Steam64 ID (the 7656119… number).");
    throw new ApiError(400, `To search by FACEIT nickname, add your FACEIT API key in ⚙ Settings (keys are saved per browser, so add it once on each device). Without a key, search by Steam64 ID (the 7656119… number).`);
  }

  /* ------------------------------------------------------------- FACEIT --- */
  /** Exact nickname lookup is case-sensitive; fall back to FACEIT's search, which isn't. */
  async function findFaceitPlayer(nick, key) {
    try { return await faceitGet("/players", key, { nickname: nick }); }
    catch (e) { if (e.status !== 404) throw e; }
    const items = (await faceitGet("/search/players", key, { nickname: nick, game: "cs2", limit: 20 })).items || [];
    const hit = items.find((p) => (p.nickname || "").toLowerCase() === nick.toLowerCase()) || (items.length === 1 ? items[0] : null);
    if (!hit) {
      const msg = items.length
        ? `No FACEIT player named "${nick}". Did you mean: ${items.slice(0, 5).map((p) => p.nickname).join(", ")}?`
        : `No FACEIT player named "${nick}" with CS2 on their account.`;
      throw Object.assign(new ApiError(404, msg), { friendly: true });
    }
    return faceitGet(`/players/${hit.player_id}`, key);
  }

  async function fetchFaceit(ident, cfg) {
    const key = cfg.faceit_api_key;
    if (!key) return { available: false, reason: SITE_LOCKED_KEY ? "Sign in (top right) to include FACEIT data." : "No FACEIT API key set (⚙ Settings)." };
    let player;
    try {
      player = ident.faceit_nickname
        ? await findFaceitPlayer(ident.faceit_nickname, key)
        : await faceitGet("/players", key, { game: "cs2", game_player_id: ident.steam64 });
    } catch (e) {
      const reason = e.friendly ? e.message
        : e.status === 404 ? "No FACEIT account found for this Steam account."
        : [401, 403].includes(e.status) ? "FACEIT rejected the API key. Check that you pasted the whole key (⚙ Settings) and that it's still active in FACEIT App Studio. A Client side key must also allow this site's domain."
        : e.message;
      return { available: false, reason };
    }
    const pid = player.player_id;
    const raw = { available: true, player, stats: null, matches: [], errors: [] };
    try { raw.stats = await faceitGet(`/players/${pid}/stats/cs2`, key); }
    catch (e) { raw.errors.push(`lifetime stats: ${e.message}`); }
    try {
      for (const offset of [0, 100]) {
        const page = (await faceitGet(`/players/${pid}/games/cs2/stats`, key, { offset, limit: 100 })).items || [];
        raw.matches.push(...page);
        if (page.length < 100) break;
      }
    } catch (e) { raw.errors.push(`match stats: ${e.message}`); }
    return raw;
  }

  /** Rounds with 1..5 kills. FACEIT reports 2K-5K; 1K rounds are the kills left over. */
  function faceitMulti(st) {
    const mk = ["Double Kills", "Triple Kills", "Quadro Kills", "Penta Kills"].map((k) => num(pick(st, k), 0));
    const single = num(pick(st, "Kills"), 0) - mk.reduce((a, n, i) => a + (i + 2) * n, 0);
    return [Math.max(0, single), ...mk];
  }

  function normalizeFaceit(raw) {
    if (!raw.available) return raw;
    const p = raw.player, game = (p.games || {}).cs2 || {};
    const life = (raw.stats || {}).lifetime || {}, segments = (raw.stats || {}).segments || [];
    const maps = {};
    for (const s of segments) {
      if (String(s.type || "").toLowerCase() !== "map") continue;
      const st = s.stats || {};
      maps[mapKey(s.label)] = {
        matches: num(pick(st, "Matches")), winrate: num(pick(st, "Win Rate %")),
        kd: num(pick(st, "Average K/D Ratio", "K/D Ratio")), hs: num(pick(st, "Average Headshots %", "Total Headshots %")),
        adr: num(pick(st, "ADR")),
      };
    }
    const matches = (raw.matches || []).map((it) => {
      const st = it.stats || it, result = pick(st, "Result");
      return {
        id: pick(st, "Match Id"), date: iso(pick(st, "Match Finished At", "Updated At", "Created At")),
        map: mapKey(pick(st, "Map")), source: "faceit",
        outcome: String(result) === "1" ? "win" : String(result) === "0" ? "loss" : null,
        score: pick(st, "Score"), kills: num(pick(st, "Kills"), 0), deaths: num(pick(st, "Deaths"), 0),
        assists: num(pick(st, "Assists"), 0), adr: num(pick(st, "ADR")), hs_pct: num(pick(st, "Headshots %")),
        rounds: num(pick(st, "Rounds")),
        mk3plus: ["Triple Kills", "Quadro Kills", "Penta Kills"].reduce((a, k) => a + num(pick(st, k), 0), 0),
        multi: faceitMulti(st),
      };
    }).sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return {
      available: true, errors: raw.errors || [], player_id: p.player_id, nickname: p.nickname, avatar: p.avatar,
      country: p.country, url: (p.faceit_url || "").replace("{lang}", "en"),
      steam64: game.game_player_id || p.steam_id_64, elo: num(game.faceit_elo), level: num(game.skill_level), region: game.region,
      lifetime: {
        matches: num(pick(life, "Matches")), wins: num(pick(life, "Wins")), winrate: num(pick(life, "Win Rate %")),
        kd: num(pick(life, "Average K/D Ratio", "K/D Ratio")), hs: num(pick(life, "Average Headshots %", "Total Headshots %")),
        adr: num(pick(life, "ADR")), current_streak: num(pick(life, "Current Win Streak")),
        longest_streak: num(pick(life, "Longest Win Streak")), entry_success: num(pick(life, "Entry Success Rate")),
        utility_dpr: num(pick(life, "Utility Damage per Round")), flash_success: num(pick(life, "Flash Success Rate")),
        clutch_1v1: num(pick(life, "1v1 Win Rate")), clutch_1v2: num(pick(life, "1v2 Win Rate")),
        sniper_kill_rate: num(pick(life, "Sniper Kill Rate")),
        recent_results: (life["Recent Results"] || []).map(String),
      },
      maps, matches,
    };
  }

  /* ------------------------------------------------------------ Leetify --- */
  async function fetchLeetify(steam64, cfg) {
    const key = cfg.leetify_api_key;
    let profile;
    try { profile = await leetifyGet("/v3/profile", key, { steam64_id: steam64 }); }
    catch (e) {
      const reason = e.status === 404 ? "No Leetify profile found (or profile is private)." : e.status === 429 ? "Leetify rate limit hit – add an API key in Settings." : e.message;
      return { available: false, reason };
    }
    const raw = { available: true, profile, matches: [], errors: [] };
    try { raw.matches = await leetifyGet("/v3/profile/matches", key, { steam64_id: steam64 }); }
    catch (e) { raw.errors.push(`match details: ${e.message}`); }
    return raw;
  }

  const LEETIFY_SOURCE = { matchmaking: "premier", matchmaking_competitive: "competitive", matchmaking_wingman: "wingman",
    faceit: "faceit", esplay: "esplay", hltv: "pro (hltv)", renown: "renown" };
  const scale = (v) => (v == null ? null : v * 100); // leetify-style ratings come as fractions

  /** Per-match detail used by the integrity check and map coaching (ratios as %, like the profile stats). */
  const matchExt = (me) => ({
    acc_head: scale(me.accuracy_head), acc_spotted: scale(me.accuracy_enemy_spotted), spray: scale(me.spray_accuracy),
    counter_strafe: scale(me.counter_strafing_shots_good_ratio),
    flash_thrown: me.flashbang_thrown ?? null, flash_foe: me.flashbang_hit_foe ?? null, flash_friend: me.flashbang_hit_friend ?? null,
    flash_kill: me.flashbang_leading_to_kill ?? null, he_thrown: me.he_thrown ?? null, he_dmg_avg: me.he_foes_damage_avg ?? null,
    molotov_thrown: me.molotov_thrown ?? null, smoke_thrown: me.smoke_thrown ?? null, util_on_death: me.utility_on_death_avg ?? null,
    trade_opps: me.trade_kill_opportunities ?? null, trade_succ: me.trade_kills_succeed ?? null,
    traded_opps: me.traded_death_opportunities ?? null, traded_succ: me.traded_deaths_succeed ?? null,
    survived: me.rounds_survived ?? null,
  });

  function normalizeLeetify(raw, steam64) {
    if (!raw.available) return raw;
    const p = raw.profile;
    const rankById = Object.fromEntries((p.recent_matches || []).map((m) => [m.id, m]));
    const matches = [];
    for (const m of raw.matches || []) {
      const me = (m.stats || []).find((s) => s.steam64_id === steam64);
      if (!me) continue;
      const teams = m.team_scores || [];
      const mine = teams.find((t) => t.team_number === me.initial_team_number)?.score ?? null;
      const theirs = teams.find((t) => t.team_number !== me.initial_team_number)?.score ?? null;
      let outcome = null;
      if (mine != null && theirs != null) outcome = mine > theirs ? "win" : mine < theirs ? "loss" : "tie";
      const rm = rankById[m.id] || {}, kills = me.total_kills || 0;
      matches.push({
        id: m.id, faceit_id: m.data_source === "faceit" ? m.data_source_match_id : null, date: m.finished_at,
        map: mapKey(m.map_name), source: LEETIFY_SOURCE[m.data_source] || m.data_source, outcome,
        score: mine != null ? `${mine} / ${theirs}` : null,
        kills, deaths: me.total_deaths || 0, assists: me.total_assists || 0, adr: me.dpr ?? null,
        hs_pct: kills ? (100 * (me.total_hs_kills || 0)) / kills : null, rounds: me.rounds_count ?? null,
        rating: scale(me.leetify_rating), ct_rating: scale(me.ct_leetify_rating), t_rating: scale(me.t_leetify_rating),
        aim_preaim: me.preaim ?? null, reaction_ms: me.reaction_time == null ? null : me.reaction_time * 1000,
        mk3plus: ["multi3k", "multi4k", "multi5k"].reduce((a, k) => a + (me[k] || 0), 0),
        multi: [1, 2, 3, 4, 5].map((i) => me[`multi${i}k`] || 0),
        rank: rm.rank ?? null, rank_type: rm.rank_type ?? null, has_banned_player: m.has_banned_player,
        ext: matchExt(me),
      });
    }
    matches.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    const r = p.rating || {}, rk = p.ranks || {};
    return {
      available: true, errors: raw.errors || [], name: p.name, privacy: p.privacy_mode,
      url: `https://leetify.com/app/profile/${steam64}`, total_matches: p.total_matches, winrate: scale(p.winrate),
      first_match: p.first_match_date, bans: p.bans || [],
      ranks: {
        leetify: rk.leetify, premier: rk.premier, faceit: rk.faceit, faceit_elo: rk.faceit_elo, wingman: rk.wingman, renown: rk.renown,
        competitive: (rk.competitive || []).filter((c) => c.rank).map((c) => ({ map: mapKey(c.map_name), rank: c.rank })),
      },
      rating: { aim: r.aim, positioning: r.positioning, utility: r.utility, clutch: scale(r.clutch), opening: scale(r.opening),
        ct: scale(r.ct_leetify), t: scale(r.t_leetify) },
      stats: p.stats || {},
      matches,
      rank_history: [...(p.recent_matches || [])].sort((a, b) => (a.finished_at || "").localeCompare(b.finished_at || ""))
        .filter((m) => m.rank)
        .map((m) => ({ date: m.finished_at, rank: m.rank, source: LEETIFY_SOURCE[m.data_source] || m.data_source, rank_type: m.rank_type, map: mapKey(m.map_name) })),
    };
  }

  /* ---------------------------------------------------------- summarize --- */
  function mergeMatches(fc, lt) {
    const out = lt.available ? [...lt.matches] : [];
    const seen = new Set(out.filter((m) => m.faceit_id).map((m) => m.faceit_id));
    if (fc.available) {
      const fmap = Object.fromEntries(fc.matches.map((m) => [m.id, m]));
      for (const m of out) {
        const f = fmap[m.faceit_id];
        if (f && m.adr == null) m.adr = f.adr;
        if (f) m.faceit_stats = { kills: f.kills, deaths: f.deaths, rounds: f.rounds, multi: f.multi }; // for the FACEIT rating
      }
      out.push(...fc.matches.filter((m) => !seen.has(m.id)));
    }
    return out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  }

  function aggregate(ms) {
    if (!ms.length) return null;
    const sum = (f, list = ms) => list.reduce((a, m) => a + (f(m) || 0), 0);
    const k = sum((m) => m.kills), d = sum((m) => m.deaths), a = sum((m) => m.assists);
    const rounds = ms.filter((m) => m.rounds && m.adr != null);
    const adr = rounds.length ? safeDiv(sum((m) => m.adr * m.rounds, rounds), sum((m) => m.rounds, rounds)) : mean(ms.map((m) => m.adr));
    const hsList = ms.filter((m) => m.hs_pct != null);
    const hs = safeDiv(sum((m) => m.hs_pct * m.kills, hsList), sum((m) => m.kills, hsList));
    const decided = ms.filter((m) => ["win", "loss", "tie"].includes(m.outcome));
    const wins = decided.filter((m) => m.outcome === "win").length;
    const withRounds = ms.filter((m) => m.rounds);
    return {
      matches: ms.length, wins,
      winrate: decided.length ? roundOr((100 * wins) / decided.length, 1) : null,
      kd: roundOr(safeDiv(k, d), 2), kpr: roundOr(safeDiv(sum((m) => m.kills, withRounds), sum((m) => m.rounds, withRounds)), 2),
      adr: roundOr(adr, 1), hs: roundOr(hs, 1),
      kills_avg: roundOr(k / ms.length, 1), deaths_avg: roundOr(d / ms.length, 1), assists_avg: roundOr(a / ms.length, 1),
      rating: roundOr(mean(ms.map((m) => m.rating)), 2),
      mk3plus_per_match: roundOr(sum((m) => m.mk3plus) / ms.length, 2),
    };
  }

  function streaks(ms) {
    const seq = [...ms].reverse().map((m) => m.outcome).filter((o) => o === "win" || o === "loss");
    let bestW = 0, bestL = 0, cur = 0, last = null;
    for (const o of seq) {
      cur = o === last ? cur + 1 : 1; last = o;
      if (o === "win") bestW = Math.max(bestW, cur); else bestL = Math.max(bestL, cur);
    }
    return { current: seq.length ? cur : 0, current_type: last, longest_win: bestW, longest_loss: bestL };
  }

  function mapPool(ms, fc) {
    const pool = {};
    for (const m of ms) (pool[m.map] ||= []).push(m);
    const fmaps = fc.available ? fc.maps || {} : {};
    const names = new Set([...Object.keys(pool), ...Object.keys(fmaps)]);
    return [...names].map((name) => ({ map: name, recent: aggregate(pool[name] || []) || {}, faceit: fmaps[name] || {} }))
      .sort((a, b) => ((b.recent.matches || 0) + (b.faceit.matches || 0) / 10) - ((a.recent.matches || 0) + (a.faceit.matches || 0) / 10));
  }

  // Rough reference points used for strengths/weaknesses. They are rules of thumb,
  // not official benchmarks; the UI labels them as such.
  const lr = (s, k) => s.leetify.rating?.[k];
  const ls = (s, k) => s.leetify.stats?.[k];
  const RULES = [
    // [label, getter, good_if, bad_if, unit, higher_is_better]
    ["Aim rating", (s) => lr(s, "aim"), 65, 40, "", true],
    ["Positioning rating", (s) => lr(s, "positioning"), 65, 40, "", true],
    ["Utility rating", (s) => lr(s, "utility"), 65, 40, "", true],
    ["Clutching", (s) => lr(s, "clutch"), 2, -2, "", true],
    ["Opening duels", (s) => lr(s, "opening"), 2, -2, "", true],
    ["Crosshair placement (preaim)", (s) => ls(s, "preaim"), 6, 10, "°", false],
    ["Reaction time", (s) => ls(s, "reaction_time_ms"), 500, 650, " ms", false],
    ["Counter-strafing", (s) => ls(s, "counter_strafing_good_shots_ratio"), 80, 60, "%", true],
    ["Spray accuracy", (s) => ls(s, "spray_accuracy"), 45, 25, "%", true],
    ["Trade kill success", (s) => ls(s, "trade_kills_success_percentage"), 55, 35, "%", true],
    ["Unused utility on death ($)", (s) => ls(s, "utility_on_death_avg"), 150, 300, "", false],
    ["Flashes blinding teammates", (s) => ls(s, "flashbang_hit_friend_per_flashbang"), 0.3, 0.6, "/flash", false],
    ["K/D (recent)", (s) => s.overall?.kd, 1.15, 0.9, "", true],
    ["ADR (recent)", (s) => s.overall?.adr, 85, 70, "", true],
    ["Win rate (recent)", (s) => s.overall?.winrate, 55, 45, "%", true],
  ];

  function insights(s) {
    const out = [];
    for (const [label, get, good, bad, unit, hib] of RULES) {
      const v = get(s);
      if (v == null) continue;
      const isGood = hib ? v >= good : v <= good, isBad = hib ? v <= bad : v >= bad;
      if (isGood || isBad)
        out.push({ type: isGood ? "strength" : "weakness", label, value: roundOr(v, 2), unit,
          ref: `${hib ? "≥" : "≤"}${good}${unit} good · ${hib ? "≤" : "≥"}${bad}${unit} weak` });
    }
    const pool = s.map_pool.filter((r) => (r.recent.matches || 0) >= 3 && r.recent.winrate != null);
    if (pool.length >= 2) {
      const cmp = (a, b) => (a.recent.winrate - b.recent.winrate) || ((a.recent.rating || 0) - (b.recent.rating || 0));
      const best = pool.reduce((a, b) => (cmp(b, a) > 0 ? b : a)), worst = pool.reduce((a, b) => (cmp(b, a) < 0 ? b : a));
      out.push({ type: "strength", label: `Best map: ${best.map}`, value: best.recent.winrate, unit: "% WR", ref: `${best.recent.matches} recent matches` });
      if (worst !== best)
        out.push({ type: "weakness", label: `Weakest map: ${worst.map}`, value: worst.recent.winrate, unit: "% WR", ref: `${worst.recent.matches} recent matches` });
    }
    const f = s.form;
    if (f.last10 && f.previous) {
      let a = f.last10.rating, b = f.previous.rating, key = "rating";
      if (a == null || b == null) { a = f.last10.kd; b = f.previous.kd; key = "kd"; }
      if (a != null && b != null && Math.abs(a - b) >= (key === "rating" ? 1.0 : 0.1)) {
        const delta = a - b;
        out.push({ type: delta > 0 ? "strength" : "weakness", label: `Form ${delta > 0 ? "improving" : "dropping"}`,
          value: roundOr(delta, 2), unit: key === "rating" ? " Leetify rating" : " K/D", ref: "last 10 matches vs. the ones before" });
      }
    }
    return out;
  }

  function performanceScore(s) {
    const parts = [], clamp = (x) => Math.max(0, Math.min(100, x));
    const r = s.leetify.available ? s.leetify.rating || {} : {};
    for (const [k, w] of [["aim", 0.2], ["positioning", 0.15], ["utility", 0.1]]) if (r[k] != null) parts.push([clamp(r[k]), w]);
    const o = s.overall || {};
    if (o.kd != null) parts.push([clamp(50 + (o.kd - 1.0) * 100), 0.2]);
    if (o.adr != null) parts.push([clamp(50 + (o.adr - 77) * 2), 0.15]);
    if (o.rating != null) parts.push([clamp(50 + o.rating * 10), 0.2]);
    if (o.winrate != null) parts.push([clamp(o.winrate), 0.1]);
    if (!parts.length) return null;
    return Math.round(parts.reduce((a, [v, w]) => a + v * w, 0) / parts.reduce((a, [, w]) => a + w, 0));
  }

  function buildSummary(fc, lt, steam64) {
    const ms = mergeMatches(fc, lt);
    const s = { faceit: fc, leetify: lt, steam64, matches: ms };
    s.overall = aggregate(ms);
    s.form = { last10: aggregate(ms.slice(0, 10)), last20: aggregate(ms.slice(0, 20)), previous: aggregate(ms.slice(10)) };
    s.by_source = Object.fromEntries([...new Set(ms.map((m) => m.source))].sort().map((src) => [src, aggregate(ms.filter((m) => m.source === src))]));
    s.streaks = streaks(ms);
    s.map_pool = mapPool(ms, fc);
    s.insights = insights(s);
    s.score = performanceScore(s);
    s.identity = {
      name: (fc.available && fc.nickname) || (lt.available && lt.name) || steam64,
      avatar: fc.available ? fc.avatar : null, country: fc.available ? fc.country : null,
      steam_url: steam64 ? `https://steamcommunity.com/profiles/${steam64}` : null,
      faceit_url: fc.available ? fc.url : null, leetify_url: lt.available ? lt.url : null,
    };
    return s;
  }

  /* ---------------------------------------------------------- snapshots --- */
  function recordSnapshot(s) {
    const fc = s.faceit, lt = s.leetify, o = s.overall || {};
    const snap = {
      ts: nowIso(),
      faceit_elo: fc.available ? fc.elo : null, faceit_level: fc.available ? fc.level : null,
      faceit_matches: fc.available ? fc.lifetime?.matches : null,
      premier: lt.available ? lt.ranks?.premier : null, leetify_rating: lt.available ? lt.ranks?.leetify : null,
      aim: lt.available ? lt.rating?.aim : null, positioning: lt.available ? lt.rating?.positioning : null,
      utility: lt.available ? lt.rating?.utility : null, leetify_matches: lt.available ? lt.total_matches : null,
      kd: o.kd ?? null, adr: o.adr ?? null, winrate: o.winrate ?? null, score: s.score,
    };
    const all = allSnapshots();
    const doc = all[s.steam64] || { steam64: s.steam64, name: null, snapshots: [] };
    doc.name = s.identity.name; doc.avatar = s.identity.avatar;
    const snaps = doc.snapshots, last = snaps[snaps.length - 1];
    // one snapshot per 10 minutes is plenty; newer lookups replace the last one
    if (last && Date.now() - new Date(last.ts).getTime() < 10 * 60 * 1000) snaps[snaps.length - 1] = snap;
    else snaps.push(snap);
    all[s.steam64] = doc;
    writeJSON(SNAP_KEY, all);
    return doc;
  }

  function trackedPlayers() {
    return Object.values(allSnapshots()).filter((d) => d && d.steam64 && Array.isArray(d.snapshots)).map((d) => {
      const last = d.snapshots[d.snapshots.length - 1] || {};
      return { steam64: d.steam64, name: d.name, avatar: d.avatar, last: last.ts, elo: last.faceit_elo, premier: last.premier, count: d.snapshots.length };
    }).sort((a, b) => (b.last || "").localeCompare(a.last || ""));
  }

  /* --------------------------------------------------------------- demo --- */
  const DEMO_STEAM64 = "76561190000000000";

  function rng(seed) {
    let a = seed >>> 0;
    const next = () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return {
      random: next,
      int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
      choice: (xs) => xs[Math.floor(next() * xs.length)],
      gauss: (mu, sd) => mu + sd * Math.sqrt(-2 * Math.log(next() || 1e-9)) * Math.cos(2 * Math.PI * next()),
      weighted: (xs, ws) => { let r = next() * ws.reduce((a, b) => a + b, 0); for (let i = 0; i < xs.length; i++) { r -= ws[i]; if (r <= 0) return xs[i]; } return xs[xs.length - 1]; },
    };
  }

  const DEMO_UTIL = { de_anubis: 0.5, de_nuke: 0.9 }; // demo player's utility is weak on Anubis
  const DEMO_T_SIDE = { de_nuke: -0.035 }; // ...and their T side is weak on Nuke

  /** Rounds with 1..5 kills that add up to the match's kills. */
  function demoMulti(rnd, kills) {
    const m = [0, rnd.int(1, 4), rnd.int(0, 2), +(rnd.random() < 0.12), +(rnd.random() < 0.02)];
    const total = () => m.reduce((a, n, i) => a + (i + 1) * n, 0);
    while (total() > kills) m[m.findLastIndex((n) => n > 0)]--;
    m[0] = kills - total();
    return m;
  }

  /** Utility/trade/accuracy fields of a demo match, in Leetify's per-match shape. */
  function demoDetail(rnd, mp, rounds) {
    const u = DEMO_UTIL[mp] || 1, clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const flashes = Math.max(1, Math.round(rounds * (0.25 + 0.25 * u) + rnd.gauss(0, 1.2)));
    const tradeOpps = Math.max(1, Math.round(rounds * 0.3 + rnd.gauss(0, 1)));
    const tradedOpps = Math.max(1, Math.round(rounds * 0.25 + rnd.gauss(0, 1)));
    return {
      flashbang_thrown: flashes,
      flashbang_hit_foe: Math.round(flashes * clamp(0.5 * u + rnd.gauss(0, 0.08), 0.05, 1.2)),
      flashbang_hit_friend: Math.round(flashes * clamp(0.25 + (1 - u) * 0.5 + rnd.gauss(0, 0.08), 0, 1)),
      flashbang_leading_to_kill: Math.round(flashes * clamp(0.12 * u + rnd.gauss(0, 0.04), 0, 0.5)),
      he_thrown: Math.max(0, Math.round(rounds * 0.2 * u + rnd.gauss(0, 1))),
      he_foes_damage_avg: roundOr(clamp(14 * u + rnd.gauss(0, 3), 0, 40), 1),
      molotov_thrown: Math.max(0, Math.round(rounds * 0.2 * u + rnd.gauss(0, 1))),
      smoke_thrown: Math.max(0, Math.round(rounds * 0.45 * u + rnd.gauss(0, 1.5))),
      utility_on_death_avg: roundOr(clamp(180 + (1 - u) * 400 + rnd.gauss(0, 40), 0, 900), 1),
      trade_kill_opportunities: tradeOpps,
      trade_kills_succeed: Math.round(tradeOpps * clamp(0.55 + rnd.gauss(0, 0.12), 0, 1)),
      traded_death_opportunities: tradedOpps,
      traded_deaths_succeed: Math.round(tradedOpps * clamp(0.4 + rnd.gauss(0, 0.12), 0, 1)),
      rounds_survived: Math.max(0, Math.round(rounds * clamp(0.3 + rnd.gauss(0, 0.07), 0, 1))),
      accuracy_head: clamp(0.21 + rnd.gauss(0, 0.04), 0, 1),
      accuracy_enemy_spotted: clamp(0.36 + rnd.gauss(0, 0.05), 0, 1),
      spray_accuracy: clamp(0.39 + rnd.gauss(0, 0.08), 0, 1),
      counter_strafing_shots_good_ratio: clamp(0.82 + rnd.gauss(0, 0.06), 0, 1),
    };
  }

  /** Synthetic data in the same shape as the real APIs, so demo exercises the full pipeline. */
  function demoRaw() {
    const rnd = rng(42);
    const maps = ["de_mirage", "de_inferno", "de_ancient", "de_nuke", "de_anubis", "de_dust2", "de_overpass"];
    const skill = { de_mirage: 0.15, de_inferno: 0.08, de_ancient: 0.0, de_nuke: -0.12, de_anubis: 0.05, de_dust2: 0.1, de_overpass: -0.05 };
    const now = Date.now(), premier = 16480, elo = 1785;
    const lMatches = [], lRecent = [], fItems = [];
    for (let i = 0; i < 100; i++) {
      const when = new Date(now - (i * 19 + rnd.int(0, 6)) * 3600e3);
      const mp = rnd.choice(maps), trend = ((100 - i) / 100) * 0.12; // gets better over time
      const form = skill[mp] + trend + rnd.gauss(0, 0.25);
      const rounds = rnd.int(16, 25); // MR12: 13 wins, loser max 12
      const win = form + rnd.gauss(0, 0.3) > -0.1;
      const [my, op] = win ? [13, Math.max(0, rounds - 13)] : [Math.max(0, rounds - 13), 13];
      const kills = Math.max(3, Math.floor(rounds * (0.72 + form * 0.5) + rnd.gauss(0, 2)));
      const deaths = Math.max(4, Math.floor(rounds * (0.68 - form * 0.3) + rnd.gauss(0, 2)));
      const hs = Math.floor(kills * Math.min(0.75, Math.max(0.2, 0.47 + rnd.gauss(0, 0.1))));
      const src = rnd.weighted(["faceit", "matchmaking", "matchmaking_competitive"], [0.55, 0.35, 0.1]);
      const rating = form * 0.04, mid = `demo-${String(i).padStart(3, "0")}`, fid = src === "faceit" ? `1-${mid}` : null;
      const mk = demoMulti(rnd, kills);
      const finished = when.toISOString();
      lMatches.push({
        id: mid, finished_at: finished, data_source: src, data_source_match_id: fid, map_name: mp, has_banned_player: false,
        team_scores: [{ team_number: 2, score: my }, { team_number: 3, score: op }],
        stats: [{
          steam64_id: DEMO_STEAM64, name: "demo_player", initial_team_number: 2, total_kills: kills, total_deaths: deaths,
          total_assists: rnd.int(1, 7), total_hs_kills: hs, dpr: roundOr((kills / rounds) * 112 + rnd.gauss(0, 6), 1),
          rounds_count: my + op, leetify_rating: rating, ct_leetify_rating: rating + rnd.gauss(0, 0.02),
          t_leetify_rating: rating + (DEMO_T_SIDE[mp] || 0) + rnd.gauss(0, 0.02),
          preaim: roundOr(7.5 - trend * 10 + rnd.gauss(0, 1), 2), reaction_time: 0.55 - trend * 0.4 + rnd.gauss(0, 0.04),
          multi1k: mk[0], multi2k: mk[1], multi3k: mk[2], multi4k: mk[3], multi5k: mk[4],
          ...demoDetail(rnd, mp, my + op),
        }],
      });
      // walking back in time: ratings were lower in the past
      let rank = null;
      if (src === "matchmaking") rank = Math.round(premier - i * 22 + rnd.gauss(0, 180));
      else if (src === "faceit") rank = elo - i * 2 >= 1701 ? 8 : 7;
      lRecent.push({ id: mid, finished_at: finished, data_source: src, rank, rank_type: src === "matchmaking" ? 11 : null, map_name: mp });
      if (src === "faceit")
        fItems.push({ stats: { "Match Id": fid, Map: mp, Kills: String(kills), Deaths: String(deaths), Assists: "3",
          ADR: String(roundOr((kills / rounds) * 112, 1)), "Headshots %": String(Math.round((100 * hs) / kills)),
          Result: win ? "1" : "0", Score: `${my} / ${op}`, Rounds: String(my + op), "Double Kills": String(mk[1]), "Triple Kills": String(mk[2]),
          "Quadro Kills": String(mk[3]), "Penta Kills": String(mk[4]), "Match Finished At": when.getTime() } });
    }
    const leetify = { available: true, errors: [], matches: lMatches, profile: {
      privacy_mode: "public", winrate: 0.54, total_matches: 812, first_match_date: "2023-09-27T18:00:00Z", name: "demo_player",
      bans: [], steam64_id: DEMO_STEAM64,
      ranks: { leetify: 1.42, premier, faceit: 8, faceit_elo: elo, wingman: 14, renown: null,
        competitive: [{ map_name: "de_mirage", rank: 15 }, { map_name: "de_inferno", rank: 13 }, { map_name: "de_nuke", rank: 11 }] },
      rating: { aim: 71.4, positioning: 58.2, utility: 37.9, clutch: 0.031, opening: -0.024, ct_leetify: 0.021, t_leetify: 0.008 },
      stats: { accuracy_enemy_spotted: 36.1, accuracy_head: 21.4, counter_strafing_good_shots_ratio: 82.5,
        ct_opening_aggression_success_rate: 61.2, ct_opening_duel_success_percentage: 52.4, flashbang_hit_foe_avg_duration: 2.1,
        flashbang_hit_foe_per_flashbang: 0.42, flashbang_hit_friend_per_flashbang: 0.64, flashbang_leading_to_kill: 4.2,
        flashbang_thrown: 11.3, he_foes_damage_avg: 6.8, he_friends_damage_avg: 1.9, preaim: 6.4, reaction_time_ms: 498,
        spray_accuracy: 38.7, t_opening_aggression_success_rate: 48.9, t_opening_duel_success_percentage: 44.1,
        traded_deaths_success_percentage: 39.2, trade_kill_opportunities_per_round: 0.31, trade_kills_success_percentage: 58.3,
        utility_on_death_avg: 342.1 },
      recent_matches: lRecent, recent_teammates: [] } };
    const faceit = { available: true, errors: [], matches: fItems,
      player: { player_id: "demo", nickname: "demo_player", avatar: "", country: "dk", faceit_url: "https://www.faceit.com/{lang}/players/demo_player",
        games: { cs2: { faceit_elo: elo, skill_level: 8, game_player_id: DEMO_STEAM64, region: "EU" } } },
      stats: { lifetime: { Matches: "642", Wins: "347", "Win Rate %": "54", "Average K/D Ratio": "1.12", "Average Headshots %": "48",
          ADR: "81.4", "Current Win Streak": "2", "Longest Win Streak": "9", "Entry Success Rate": "0.47", "Utility Damage per Round": "6.1",
          "Flash Success Rate": "0.41", "1v1 Win Rate": "0.58", "1v2 Win Rate": "0.24", "Sniper Kill Rate": "0.06",
          "Recent Results": ["1", "1", "0", "1", "0"] },
        segments: maps.map((m) => ({ type: "Map", mode: "5v5", label: m, stats: { Matches: String(rnd.int(40, 140)),
          "Win Rate %": String(Math.round(52 + skill[m] * 60)), "Average K/D Ratio": String(roundOr(1.1 + skill[m], 2)),
          "Average Headshots %": String(rnd.int(42, 52)), ADR: String(roundOr(80 + skill[m] * 40, 1)) } })) } };
    return [faceit, leetify];
  }

  function demoHistory() {
    const rnd = rng(7), now = Date.now(), snaps = [];
    let elo = 1520, prem = 13900, lrt = -0.6;
    for (let i = 30; i > 0; i--) {
      elo += rnd.int(-25, 40); prem += rnd.int(-250, 380); lrt += rnd.gauss(0.07, 0.25);
      snaps.push({ ts: new Date(now - i * 3 * 86400e3).toISOString(), faceit_elo: elo, faceit_level: Math.min(10, Math.floor((elo - 500) / 150) + 1),
        premier: prem, leetify_rating: roundOr(lrt, 2), aim: roundOr(60 + (30 - i) * 0.35 + rnd.gauss(0, 1.5), 1),
        positioning: roundOr(52 + (30 - i) * 0.2 + rnd.gauss(0, 1.5), 1), utility: roundOr(35 + (30 - i) * 0.1 + rnd.gauss(0, 1.5), 1),
        kd: roundOr(1.0 + (30 - i) * 0.004 + rnd.gauss(0, 0.04), 2), adr: roundOr(76 + (30 - i) * 0.15 + rnd.gauss(0, 2), 1),
        winrate: roundOr(50 + rnd.gauss(2, 3), 1) });
    }
    return snaps;
  }

  /* -------------------------------------------------------------- views --- */
  async function lookup(q) {
    const cfg = loadConfig();
    if (q.trim().toLowerCase() === "demo") {
      const [fr, lrw] = demoRaw();
      const s = buildSummary(normalizeFaceit(fr), normalizeLeetify(lrw, DEMO_STEAM64), DEMO_STEAM64);
      s.demo = true; s.history = demoHistory();
      return s;
    }
    const ident = resolveQuery(q, cfg);
    const fc = normalizeFaceit(await fetchFaceit(ident, cfg));
    const steam64 = ident.steam64 || (fc.available ? fc.steam64 : null);
    if (!steam64) throw new ApiError(404, fc.available ? `FACEIT account "${fc.nickname}" has no CS2 profile linked.` : fc.reason || "Could not determine the player's Steam64 ID.");
    const lt = normalizeLeetify(await fetchLeetify(steam64, cfg), steam64);
    if (!fc.available && !lt.available) throw new ApiError(404, `No data. FACEIT: ${fc.reason}  Leetify: ${lt.reason}`);
    const s = buildSummary(fc, lt, steam64);
    s.history = recordSnapshot(s).snapshots;
    return s;
  }

  const configView = () => {
    const c = loadConfig();
    const own = storedConfig().faceit_api_key, signedIn = !!unlockedKey();
    return { faceit: !!c.faceit_api_key, leetify: !!c.leetify_api_key, locked: false, mode: "browser",
      faceit_builtin: !!SITE_FACEIT_KEY && !own && !signedIn,
      faceit_lock: !!SITE_LOCKED_KEY, signed_in: signedIn, faceit_own: !!own };
  };

  /** Same routes as server.py, answered in the browser. */
  async function handle(path, opts = {}) {
    const u = new URL(path, "http://x/");
    const body = opts.body ? JSON.parse(opts.body) : {};
    switch (`${opts.method || "GET"} ${u.pathname}`) {
      case "GET /api/player": return lookup(u.searchParams.get("q") || "");
      case "GET /api/tracked": return trackedPlayers();
      case "GET /api/config": return configView();
      case "POST /api/config": {
        const c = storedConfig();
        for (const k of ["faceit_api_key", "leetify_api_key"]) if (typeof body[k] === "string") c[k] = body[k].trim();
        writeJSON(CFG_KEY, c); cache.clear();
        return configView();
      }
      case "POST /api/untrack": {
        const all = allSnapshots(); delete all[body.steam64]; writeJSON(SNAP_KEY, all);
        return { ok: true };
      }
    }
    throw new ApiError(404, "Not found");
  }

  /** Progress history backup, so it can be moved between browsers. */
  const exportHistory = () => JSON.stringify({ app: "cs2-tracker", version: 1, exported: nowIso(), players: allSnapshots() }, null, 1);
  function importHistory(text) {
    const data = JSON.parse(text);
    const incoming = data && data.app === "cs2-tracker" ? data.players : null;
    if (!incoming || typeof incoming !== "object") throw new Error("That file isn't a CS2 Tracker history export.");
    const all = allSnapshots();
    let added = 0;
    for (const [id, doc] of Object.entries(incoming)) {
      if (!doc || !Array.isArray(doc.snapshots)) continue;
      const cur = all[id] || { ...doc, snapshots: [] };
      const seen = new Set(cur.snapshots.map((s) => s.ts));
      for (const s of doc.snapshots) if (s && s.ts && !seen.has(s.ts)) { cur.snapshots.push(s); added++; }
      cur.snapshots.sort((a, b) => a.ts.localeCompare(b.ts));
      cur.name = cur.name || doc.name; cur.avatar = cur.avatar || doc.avatar;
      all[id] = cur;
    }
    writeJSON(SNAP_KEY, all);
    return added;
  }

  return { handle, exportHistory, importHistory, lockKey, unlock, signOut };
})();
