"""CS2 Tracker - server.

Combines FACEIT Data API v4 and the Leetify Public CS API into one statistical
summary per player, and stores a snapshot on every lookup so progress can be
tracked over time. Standard library only (Python 3.9+).

Run locally:  python server.py   then open http://127.0.0.1:8765

Environment (all optional locally, see README for cloud hosting):
  HOST, PORT                    bind address (default 127.0.0.1:8765)
  APP_PASSWORD                  require this password (HTTP Basic auth)
  FACEIT_API_KEY, LEETIFY_API_KEY
  LOCK_CONFIG=1                 keys come from env only; Settings is read-only
  GITHUB_TOKEN, GITHUB_REPO     store snapshots in a GitHub repo instead of data/
  GITHUB_BRANCH                 branch for snapshots (default "data")
"""
import base64
import hmac
import json
import math
import os
import random
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
DATA = os.path.join(ROOT, "data")
SNAP_DIR = os.path.join(DATA, "snapshots")
CONFIG_PATH = os.path.join(DATA, "config.json")
PORT = int(os.environ.get("PORT", "8765"))
HOST = os.environ.get("HOST", "127.0.0.1")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
CONFIG_LOCKED = os.environ.get("LOCK_CONFIG", "").lower() in ("1", "true", "yes")
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
GITHUB_REPO = os.environ.get("GITHUB_REPO", "")
GITHUB_BRANCH = os.environ.get("GITHUB_BRANCH", "data")

FACEIT_BASE = "https://open.faceit.com/data/v4"
LEETIFY_BASE = "https://api-public.cs-prod.leetify.com"
CACHE_TTL = 120
STEAM64_RE = re.compile(r"7656119\d{10}")

os.makedirs(SNAP_DIR, exist_ok=True)
_cache = {}
_lock = threading.Lock()


# ---------------------------------------------------------------- config ---

def load_config():
    cfg = {"faceit_api_key": "", "leetify_api_key": ""}
    try:
        with open(CONFIG_PATH, encoding="utf-8") as f:
            cfg.update(json.load(f))
    except (OSError, ValueError):
        pass
    cfg["faceit_api_key"] = os.environ.get("FACEIT_API_KEY") or cfg["faceit_api_key"]
    cfg["leetify_api_key"] = os.environ.get("LEETIFY_API_KEY") or cfg["leetify_api_key"]
    return cfg


def save_config(update):
    cfg = load_config()
    for k in ("faceit_api_key", "leetify_api_key"):
        if k in update and isinstance(update[k], str):
            cfg[k] = update[k].strip()
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(cfg, f, indent=2)
    return cfg


# ------------------------------------------------------------------ http ---

class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def http_get(url, headers=None, as_json=True):
    with _lock:
        hit = _cache.get(url)
        if hit and time.time() - hit[0] < CACHE_TTL:
            return hit[1]
    req = urllib.request.Request(url, headers={"User-Agent": "cs2-tracker/1.0", **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            body = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise ApiError(e.code, f"HTTP {e.code} from {urllib.parse.urlparse(url).netloc}")
    except (urllib.error.URLError, TimeoutError) as e:
        raise ApiError(0, f"Network error: {e}")
    data = json.loads(body) if as_json else body
    with _lock:
        _cache[url] = (time.time(), data)
    return data


def faceit_get(path, key, **params):
    qs = ("?" + urllib.parse.urlencode(params)) if params else ""
    return http_get(FACEIT_BASE + path + qs, {"Authorization": f"Bearer {key}"})


def leetify_get(path, key, **params):
    headers = {"_leetify_key": key} if key else {}
    return http_get(LEETIFY_BASE + path + "?" + urllib.parse.urlencode(params), headers)


# --------------------------------------------------------------- helpers ---

def num(v, default=None):
    if v is None or v == "":
        return default
    try:
        f = float(str(v).replace(",", "").replace("%", ""))
        return default if math.isnan(f) else f
    except ValueError:
        return default


def pick(d, *keys, default=None):
    for k in keys:
        if isinstance(d, dict) and d.get(k) not in (None, ""):
            return d[k]
    return default


def safe_div(a, b):
    return a / b if b else None


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def map_key(name):
    if not name:
        return "Unknown"
    n = re.sub(r"^(de|cs|ar|dz)_", "", str(name).strip().lower())
    return n.replace("_", " ").title()


def iso(ts):
    """Accept ISO strings or unix seconds/ms; return ISO UTC string."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)) or str(ts).isdigit():
        t = float(ts)
        if t > 1e12:
            t /= 1000
        return datetime.fromtimestamp(t, timezone.utc).isoformat().replace("+00:00", "Z")
    return str(ts)


def round_or(v, nd=2):
    return None if v is None else round(v, nd)


# ------------------------------------------------------------- resolving ---

def resolve_query(q, cfg):
    """Turn user input into {steam64, faceit_nickname}."""
    q = q.strip()
    out = {"steam64": None, "faceit_nickname": None}
    m = STEAM64_RE.search(q)
    if m:
        out["steam64"] = m.group(0)
        return out
    m = re.search(r"faceit\.com/(?:[a-z-]+/)?players/([^/?#]+)", q, re.I)
    if m:
        out["faceit_nickname"] = urllib.parse.unquote(m.group(1))
        return out
    m = re.search(r"steamcommunity\.com/id/([^/?#]+)", q, re.I)
    vanity = m.group(1) if m else None
    if vanity is None and cfg["faceit_api_key"]:
        out["faceit_nickname"] = q.lstrip("@")
        return out
    vanity = vanity or q
    try:
        xml = http_get(f"https://steamcommunity.com/id/{urllib.parse.quote(vanity)}/?xml=1", as_json=False)
        m = re.search(r"<steamID64>(\d+)</steamID64>", xml)
        if m:
            out["steam64"] = m.group(1)
    except ApiError:
        pass
    if not out["steam64"]:
        hint = "" if cfg["faceit_api_key"] else " To search by FACEIT nickname, add your FACEIT API key in ⚙ Settings."
        raise ApiError(404, f"Could not find a Steam profile called \"{vanity}\". Use a Steam64 ID or Steam profile URL.{hint}")
    return out


# ---------------------------------------------------------------- FACEIT ---

class FriendlyError(ApiError):
    """An ApiError whose message is ready to show to the user as-is."""


def find_faceit_player(nick, key):
    """Exact nickname lookup is case-sensitive; fall back to FACEIT's search, which isn't."""
    try:
        return faceit_get("/players", key, nickname=nick)
    except ApiError as e:
        if e.status != 404:
            raise
    items = faceit_get("/search/players", key, nickname=nick, game="cs2", limit=20).get("items") or []
    hit = next((p for p in items if (p.get("nickname") or "").lower() == nick.lower()), None) or (items[0] if len(items) == 1 else None)
    if not hit:
        if items:
            raise FriendlyError(404, f'No FACEIT player named "{nick}". Did you mean: {", ".join(p["nickname"] for p in items[:5])}?')
        raise FriendlyError(404, f'No FACEIT player named "{nick}" with CS2 on their account.')
    return faceit_get(f"/players/{hit['player_id']}", key)


def fetch_faceit(ident, cfg):
    key = cfg["faceit_api_key"]
    if not key:
        return {"available": False, "reason": "No FACEIT API key configured (Settings)."}
    try:
        if ident.get("faceit_nickname"):
            player = find_faceit_player(ident["faceit_nickname"], key)
        else:
            player = faceit_get("/players", key, game="cs2", game_player_id=ident["steam64"])
    except FriendlyError as e:
        return {"available": False, "reason": str(e)}
    except ApiError as e:
        reason = ("No FACEIT account found for this Steam account." if e.status == 404 else
                  "FACEIT rejected the API key. Use a \"Server side\" key from FACEIT App Studio." if e.status in (401, 403) else str(e))
        return {"available": False, "reason": reason}
    pid = player["player_id"]
    raw = {"available": True, "player": player, "stats": None, "matches": [], "errors": []}
    try:
        raw["stats"] = faceit_get(f"/players/{pid}/stats/cs2", key)
    except ApiError as e:
        raw["errors"].append(f"lifetime stats: {e}")
    try:
        for offset in (0, 100):
            page = faceit_get(f"/players/{pid}/games/cs2/stats", key, offset=offset, limit=100).get("items", [])
            raw["matches"] += page
            if len(page) < 100:
                break
    except ApiError as e:
        raw["errors"].append(f"match stats: {e}")
    return raw


def faceit_multi(st):
    """Rounds with 1..5 kills. FACEIT reports 2K-5K; 1K rounds are the kills left over."""
    mk = [num(pick(st, k), 0) for k in ("Double Kills", "Triple Kills", "Quadro Kills", "Penta Kills")]
    single = num(pick(st, "Kills"), 0) - sum((i + 2) * n for i, n in enumerate(mk))
    return [max(0, single)] + mk


def normalize_faceit(raw):
    if not raw.get("available"):
        return raw
    p = raw["player"]
    game = (p.get("games") or {}).get("cs2") or {}
    life = (raw.get("stats") or {}).get("lifetime") or {}
    segments = (raw.get("stats") or {}).get("segments") or []
    maps = {}
    for s in segments:
        if str(s.get("type", "")).lower() != "map":
            continue
        st = s.get("stats", {})
        maps[map_key(s.get("label"))] = {
            "matches": num(pick(st, "Matches")),
            "winrate": num(pick(st, "Win Rate %")),
            "kd": num(pick(st, "Average K/D Ratio", "K/D Ratio")),
            "hs": num(pick(st, "Average Headshots %", "Total Headshots %")),
            "adr": num(pick(st, "ADR")),
        }
    matches = []
    for it in raw.get("matches", []):
        st = it.get("stats", it)
        kills, deaths = num(pick(st, "Kills"), 0), num(pick(st, "Deaths"), 0)
        rounds = num(pick(st, "Rounds"))
        result = pick(st, "Result")
        matches.append({
            "id": pick(st, "Match Id"),
            "date": iso(pick(st, "Match Finished At", "Updated At", "Created At")),
            "map": map_key(pick(st, "Map")),
            "source": "faceit",
            "outcome": "win" if str(result) == "1" else "loss" if str(result) == "0" else None,
            "score": pick(st, "Score"),
            "kills": kills, "deaths": deaths, "assists": num(pick(st, "Assists"), 0),
            "adr": num(pick(st, "ADR")),
            "hs_pct": num(pick(st, "Headshots %")),
            "rounds": rounds,
            "mk3plus": sum(num(pick(st, k), 0) for k in ("Triple Kills", "Quadro Kills", "Penta Kills")),
            "multi": faceit_multi(st),
        })
    matches.sort(key=lambda m: m["date"] or "", reverse=True)
    recent = life.get("Recent Results") or []
    return {
        "available": True,
        "errors": raw.get("errors", []),
        "player_id": p.get("player_id"),
        "nickname": p.get("nickname"),
        "avatar": p.get("avatar"),
        "country": p.get("country"),
        "url": (p.get("faceit_url") or "").replace("{lang}", "en"),
        "steam64": game.get("game_player_id") or p.get("steam_id_64"),
        "elo": num(game.get("faceit_elo")),
        "level": num(game.get("skill_level")),
        "region": game.get("region"),
        "lifetime": {
            "matches": num(pick(life, "Matches")),
            "wins": num(pick(life, "Wins")),
            "winrate": num(pick(life, "Win Rate %")),
            "kd": num(pick(life, "Average K/D Ratio", "K/D Ratio")),
            "hs": num(pick(life, "Average Headshots %", "Total Headshots %")),
            "adr": num(pick(life, "ADR")),
            "current_streak": num(pick(life, "Current Win Streak")),
            "longest_streak": num(pick(life, "Longest Win Streak")),
            "entry_success": num(pick(life, "Entry Success Rate")),
            "utility_dpr": num(pick(life, "Utility Damage per Round")),
            "flash_success": num(pick(life, "Flash Success Rate")),
            "clutch_1v1": num(pick(life, "1v1 Win Rate")),
            "clutch_1v2": num(pick(life, "1v2 Win Rate")),
            "sniper_kill_rate": num(pick(life, "Sniper Kill Rate")),
            "recent_results": [str(r) for r in recent],
        },
        "maps": maps,
        "matches": matches,
    }


# --------------------------------------------------------------- Leetify ---

def fetch_leetify(steam64, cfg):
    key = cfg["leetify_api_key"]
    try:
        profile = leetify_get("/v3/profile", key, steam64_id=steam64)
    except ApiError as e:
        reason = "No Leetify profile found (or profile is private)." if e.status == 404 else ("Leetify rate limit hit - add an API key in Settings." if e.status == 429 else str(e))
        return {"available": False, "reason": reason}
    raw = {"available": True, "profile": profile, "matches": [], "errors": []}
    try:
        raw["matches"] = leetify_get("/v3/profile/matches", key, steam64_id=steam64)
    except ApiError as e:
        raw["errors"].append(f"match details: {e}")
    return raw


LEETIFY_SOURCE = {"matchmaking": "premier", "matchmaking_competitive": "competitive",
                  "matchmaking_wingman": "wingman", "faceit": "faceit", "esplay": "esplay",
                  "hltv": "pro (hltv)", "renown": "renown"}


def match_ext(me):
    """Per-match detail used by the integrity check and map coaching (ratios as %, like the profile stats)."""
    pct = lambda v: None if v is None else v * 100
    return {
        "acc_head": pct(me.get("accuracy_head")), "acc_spotted": pct(me.get("accuracy_enemy_spotted")),
        "spray": pct(me.get("spray_accuracy")), "counter_strafe": pct(me.get("counter_strafing_shots_good_ratio")),
        "flash_thrown": me.get("flashbang_thrown"), "flash_foe": me.get("flashbang_hit_foe"),
        "flash_friend": me.get("flashbang_hit_friend"), "flash_kill": me.get("flashbang_leading_to_kill"),
        "he_thrown": me.get("he_thrown"), "he_dmg_avg": me.get("he_foes_damage_avg"),
        "molotov_thrown": me.get("molotov_thrown"), "smoke_thrown": me.get("smoke_thrown"),
        "util_on_death": me.get("utility_on_death_avg"),
        "trade_opps": me.get("trade_kill_opportunities"), "trade_succ": me.get("trade_kills_succeed"),
        "traded_opps": me.get("traded_death_opportunities"), "traded_succ": me.get("traded_deaths_succeed"),
        "survived": me.get("rounds_survived"),
    }


def normalize_leetify(raw, steam64):
    if not raw.get("available"):
        return raw
    p = raw["profile"]
    rank_by_id = {m["id"]: m for m in p.get("recent_matches", [])}
    matches = []
    for m in raw.get("matches", []):
        me = next((s for s in m.get("stats", []) if s.get("steam64_id") == steam64), None)
        if not me:
            continue
        mine = next((t["score"] for t in m.get("team_scores", []) if t["team_number"] == me.get("initial_team_number")), None)
        theirs = next((t["score"] for t in m.get("team_scores", []) if t["team_number"] != me.get("initial_team_number")), None)
        outcome = None
        if mine is not None and theirs is not None:
            outcome = "win" if mine > theirs else "loss" if mine < theirs else "tie"
        rm = rank_by_id.get(m["id"], {})
        kills = me.get("total_kills") or 0
        matches.append({
            "id": m["id"],
            "faceit_id": m.get("data_source_match_id") if m.get("data_source") == "faceit" else None,
            "date": m.get("finished_at"),
            "map": map_key(m.get("map_name")),
            "source": LEETIFY_SOURCE.get(m.get("data_source"), m.get("data_source")),
            "outcome": outcome,
            "score": f"{mine} / {theirs}" if mine is not None else None,
            "kills": kills, "deaths": me.get("total_deaths") or 0, "assists": me.get("total_assists") or 0,
            "adr": me.get("dpr"),
            "hs_pct": 100 * (me.get("total_hs_kills") or 0) / kills if kills else None,
            "rounds": me.get("rounds_count"),
            "rating": None if me.get("leetify_rating") is None else me["leetify_rating"] * 100,
            "ct_rating": None if me.get("ct_leetify_rating") is None else me["ct_leetify_rating"] * 100,
            "t_rating": None if me.get("t_leetify_rating") is None else me["t_leetify_rating"] * 100,
            "aim_preaim": me.get("preaim"),
            "reaction_ms": None if me.get("reaction_time") is None else me["reaction_time"] * 1000,
            "mk3plus": sum(me.get(k) or 0 for k in ("multi3k", "multi4k", "multi5k")),
            "multi": [me.get(f"multi{i}k") or 0 for i in range(1, 6)],
            "rank": rm.get("rank"),
            "rank_type": rm.get("rank_type"),
            "has_banned_player": m.get("has_banned_player"),
            "ext": match_ext(me),
        })
    matches.sort(key=lambda m: m["date"] or "", reverse=True)
    r, st, rk = p.get("rating") or {}, p.get("stats") or {}, p.get("ranks") or {}
    scale = lambda v: None if v is None else v * 100  # leetify-style ratings come as fractions
    return {
        "available": True,
        "errors": raw.get("errors", []),
        "name": p.get("name"),
        "privacy": p.get("privacy_mode"),
        "url": f"https://leetify.com/app/profile/{steam64}",
        "total_matches": p.get("total_matches"),
        "winrate": scale(p.get("winrate")),
        "first_match": p.get("first_match_date"),
        "bans": p.get("bans") or [],
        "ranks": {
            "leetify": rk.get("leetify"), "premier": rk.get("premier"), "faceit": rk.get("faceit"),
            "faceit_elo": rk.get("faceit_elo"), "wingman": rk.get("wingman"), "renown": rk.get("renown"),
            "competitive": [{"map": map_key(c["map_name"]), "rank": c["rank"]} for c in rk.get("competitive") or [] if c.get("rank")],
        },
        "rating": {
            "aim": r.get("aim"), "positioning": r.get("positioning"), "utility": r.get("utility"),
            "clutch": scale(r.get("clutch")), "opening": scale(r.get("opening")),
            "ct": scale(r.get("ct_leetify")), "t": scale(r.get("t_leetify")),
        },
        "stats": st,
        "matches": matches,
        "rank_history": [
            {"date": m.get("finished_at"), "rank": m.get("rank"), "source": LEETIFY_SOURCE.get(m.get("data_source"), m.get("data_source")),
             "rank_type": m.get("rank_type"), "map": map_key(m.get("map_name"))}
            for m in sorted(p.get("recent_matches", []), key=lambda x: x.get("finished_at") or "") if m.get("rank")
        ],
    }


# ------------------------------------------------------------- summarize ---

def merge_matches(fc, lt):
    """Unified match list. Leetify carries all platforms; FACEIT-only matches are appended."""
    out = list(lt.get("matches", [])) if lt.get("available") else []
    seen = {m["faceit_id"] for m in out if m.get("faceit_id")}
    if fc.get("available"):
        fmap = {m["id"]: m for m in fc["matches"]}
        for m in out:
            f = fmap.get(m.get("faceit_id"))
            if f and m.get("adr") is None:
                m["adr"] = f["adr"]
            if f:  # FACEIT's own numbers for this match, used for the FACEIT rating
                m["faceit_stats"] = {k: f[k] for k in ("kills", "deaths", "rounds", "multi")}
        out += [m for m in fc["matches"] if m["id"] not in seen]
    out.sort(key=lambda m: m["date"] or "", reverse=True)
    return out


def aggregate(ms):
    if not ms:
        return None
    k = sum(m["kills"] or 0 for m in ms)
    d = sum(m["deaths"] or 0 for m in ms)
    a = sum(m["assists"] or 0 for m in ms)
    rounds = [m for m in ms if m.get("rounds") and m.get("adr") is not None]
    adr = safe_div(sum(m["adr"] * m["rounds"] for m in rounds), sum(m["rounds"] for m in rounds)) if rounds else mean([m.get("adr") for m in ms])
    hs = safe_div(sum((m["hs_pct"] or 0) * (m["kills"] or 0) for m in ms if m.get("hs_pct") is not None), sum(m["kills"] or 0 for m in ms if m.get("hs_pct") is not None))
    decided = [m for m in ms if m.get("outcome") in ("win", "loss", "tie")]
    wins = sum(1 for m in decided if m["outcome"] == "win")
    rr = sum(m["rounds"] for m in ms if m.get("rounds"))
    kr = sum(m["kills"] or 0 for m in ms if m.get("rounds"))
    return {
        "matches": len(ms),
        "wins": wins,
        "winrate": round_or(100 * safe_div(wins, len(decided)) if decided else None, 1),
        "kd": round_or(safe_div(k, d), 2),
        "kpr": round_or(safe_div(kr, rr), 2),
        "adr": round_or(adr, 1),
        "hs": round_or(hs, 1),
        "kills_avg": round_or(k / len(ms), 1),
        "deaths_avg": round_or(d / len(ms), 1),
        "assists_avg": round_or(a / len(ms), 1),
        "rating": round_or(mean([m.get("rating") for m in ms]), 2),
        "mk3plus_per_match": round_or(sum(m.get("mk3plus") or 0 for m in ms) / len(ms), 2),
    }


def streaks(ms):
    seq = [m["outcome"] for m in reversed(ms) if m.get("outcome") in ("win", "loss")]
    best_w = best_l = cur = 0
    last = None
    for o in seq:
        cur = cur + 1 if o == last else 1
        last = o
        if o == "win":
            best_w = max(best_w, cur)
        else:
            best_l = max(best_l, cur)
    return {"current": cur if seq else 0, "current_type": last, "longest_win": best_w, "longest_loss": best_l}


def map_pool(ms, fc):
    pool = {}
    for m in ms:
        pool.setdefault(m["map"], []).append(m)
    rows = []
    names = set(pool) | set((fc.get("maps") or {}) if fc.get("available") else {})
    for name in names:
        agg = aggregate(pool.get(name, [])) or {}
        fm = (fc.get("maps") or {}).get(name, {}) if fc.get("available") else {}
        rows.append({"map": name, "recent": agg, "faceit": fm})
    rows.sort(key=lambda r: -((r["recent"].get("matches") or 0) + (r["faceit"].get("matches") or 0) / 10))
    return rows


# Rough reference points used for strengths/weaknesses. They are rules of thumb,
# not official benchmarks; the UI labels them as such.
RULES = [
    # (label, getter, good_if, bad_if, unit, higher_is_better)
    ("Aim rating", lambda s: s["leetify"].get("rating", {}).get("aim"), 65, 40, "", True),
    ("Positioning rating", lambda s: s["leetify"].get("rating", {}).get("positioning"), 65, 40, "", True),
    ("Utility rating", lambda s: s["leetify"].get("rating", {}).get("utility"), 65, 40, "", True),
    ("Clutching", lambda s: s["leetify"].get("rating", {}).get("clutch"), 2, -2, "", True),
    ("Opening duels", lambda s: s["leetify"].get("rating", {}).get("opening"), 2, -2, "", True),
    ("Crosshair placement (preaim)", lambda s: s["leetify"].get("stats", {}).get("preaim"), 6, 10, "°", False),
    ("Reaction time", lambda s: s["leetify"].get("stats", {}).get("reaction_time_ms"), 500, 650, " ms", False),
    ("Counter-strafing", lambda s: s["leetify"].get("stats", {}).get("counter_strafing_good_shots_ratio"), 80, 60, "%", True),
    ("Spray accuracy", lambda s: s["leetify"].get("stats", {}).get("spray_accuracy"), 45, 25, "%", True),
    ("Trade kill success", lambda s: s["leetify"].get("stats", {}).get("trade_kills_success_percentage"), 55, 35, "%", True),
    ("Unused utility on death ($)", lambda s: s["leetify"].get("stats", {}).get("utility_on_death_avg"), 150, 300, "", False),
    ("Flashes blinding teammates", lambda s: s["leetify"].get("stats", {}).get("flashbang_hit_friend_per_flashbang"), 0.3, 0.6, "/flash", False),
    ("K/D (recent)", lambda s: (s["overall"] or {}).get("kd"), 1.15, 0.9, "", True),
    ("ADR (recent)", lambda s: (s["overall"] or {}).get("adr"), 85, 70, "", True),
    ("Win rate (recent)", lambda s: (s["overall"] or {}).get("winrate"), 55, 45, "%", True),
]


def insights(s):
    out = []
    for label, get, good, bad, unit, hib in RULES:
        try:
            v = get(s)
        except (KeyError, TypeError, AttributeError):
            v = None
        if v is None:
            continue
        is_good = v >= good if hib else v <= good
        is_bad = v <= bad if hib else v >= bad
        if is_good or is_bad:
            out.append({"type": "strength" if is_good else "weakness", "label": label,
                        "value": round(v, 2), "unit": unit,
                        "ref": f"{'≥' if hib else '≤'}{good}{unit} good · {'≤' if hib else '≥'}{bad}{unit} weak"})
    pool = [r for r in s["map_pool"] if (r["recent"].get("matches") or 0) >= 3 and r["recent"].get("winrate") is not None]
    if len(pool) >= 2:
        best = max(pool, key=lambda r: (r["recent"]["winrate"], r["recent"].get("rating") or 0))
        worst = min(pool, key=lambda r: (r["recent"]["winrate"], r["recent"].get("rating") or 0))
        out.append({"type": "strength", "label": f"Best map: {best['map']}", "value": best["recent"]["winrate"], "unit": "% WR",
                    "ref": f"{best['recent']['matches']} recent matches"})
        if worst is not best:
            out.append({"type": "weakness", "label": f"Weakest map: {worst['map']}", "value": worst["recent"]["winrate"], "unit": "% WR",
                        "ref": f"{worst['recent']['matches']} recent matches"})
    f = s["form"]
    if f.get("last10") and f.get("previous"):
        a, b = f["last10"].get("rating"), f["previous"].get("rating")
        key = "rating"
        if a is None or b is None:
            a, b, key = f["last10"].get("kd"), f["previous"].get("kd"), "kd"
        if a is not None and b is not None:
            delta = a - b
            thresh = 1.0 if key == "rating" else 0.1
            if abs(delta) >= thresh:
                out.append({"type": "strength" if delta > 0 else "weakness",
                            "label": f"Form {'improving' if delta > 0 else 'dropping'}",
                            "value": round(delta, 2), "unit": " Leetify rating" if key == "rating" else " K/D",
                            "ref": "last 10 matches vs. the ones before"})
    return out


def performance_score(s):
    """0-100 composite. Weighted mean of the components that are available."""
    parts = []
    lr = s["leetify"].get("rating", {}) if s["leetify"].get("available") else {}
    clamp = lambda x: max(0.0, min(100.0, x))
    for k, w in (("aim", 0.2), ("positioning", 0.15), ("utility", 0.1)):
        if lr.get(k) is not None:
            parts.append((clamp(lr[k]), w))
    o = s["overall"] or {}
    if o.get("kd") is not None:
        parts.append((clamp(50 + (o["kd"] - 1.0) * 100), 0.2))
    if o.get("adr") is not None:
        parts.append((clamp(50 + (o["adr"] - 77) * 2), 0.15))
    if o.get("rating") is not None:
        parts.append((clamp(50 + o["rating"] * 10), 0.2))
    if o.get("winrate") is not None:
        parts.append((clamp(o["winrate"]), 0.1))
    if not parts:
        return None
    return round(sum(v * w for v, w in parts) / sum(w for _, w in parts))


def build_summary(fc, lt, steam64):
    ms = merge_matches(fc, lt)
    s = {"faceit": fc, "leetify": lt, "steam64": steam64}
    s["matches"] = ms
    s["overall"] = aggregate(ms)
    s["form"] = {"last10": aggregate(ms[:10]), "last20": aggregate(ms[:20]), "previous": aggregate(ms[10:])}
    s["by_source"] = {src: aggregate([m for m in ms if m["source"] == src]) for src in sorted({m["source"] for m in ms})}
    s["streaks"] = streaks(ms)
    s["map_pool"] = map_pool(ms, fc)
    s["insights"] = insights(s)
    s["score"] = performance_score(s)
    s["identity"] = {
        "name": (fc.get("nickname") if fc.get("available") else None) or (lt.get("name") if lt.get("available") else None) or steam64,
        "avatar": fc.get("avatar") if fc.get("available") else None,
        "country": fc.get("country") if fc.get("available") else None,
        "steam_url": f"https://steamcommunity.com/profiles/{steam64}" if steam64 else None,
        "faceit_url": fc.get("url") if fc.get("available") else None,
        "leetify_url": lt.get("url") if lt.get("available") else None,
    }
    return s


# ------------------------------------------------------------- snapshots ---

def safe_id(steam64):
    return re.sub(r"[^0-9A-Za-z_-]", "", str(steam64))


class FileStore:
    """Snapshots as JSON files in data/snapshots (local use)."""

    def _path(self, sid):
        return os.path.join(SNAP_DIR, f"{safe_id(sid)}.json")

    def get(self, sid):
        try:
            with open(self._path(sid), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def put(self, sid, doc):
        with open(self._path(sid), "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=1)

    def delete(self, sid):
        try:
            os.remove(self._path(sid))
        except OSError:
            pass

    def all(self):
        docs = (self.get(fn[:-5]) for fn in os.listdir(SNAP_DIR) if fn.endswith(".json"))
        return [d for d in docs if d]


class GitHubStore:
    """Snapshots as JSON files on a branch of a GitHub repo, so they survive cloud restarts.

    Everything is loaded into memory on first use; writes go straight through to GitHub.
    """

    def __init__(self, repo, token, branch):
        self.repo, self.token, self.branch = repo, token, branch
        self.docs = None  # sid -> [doc, sha]
        self.lock = threading.Lock()

    def _req(self, method, path, body=None):
        req = urllib.request.Request(
            f"https://api.github.com/repos/{self.repo}{path}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Authorization": f"Bearer {self.token}", "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cs2-tracker/1.0"})
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                return r.status, json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            return e.code, None
        except (urllib.error.URLError, TimeoutError) as e:
            raise ApiError(502, f"GitHub storage: network error ({e}).")

    def _ensure_branch(self):
        st, _ = self._req("GET", f"/git/ref/heads/{self.branch}")
        if st == 200:
            return
        st, repo = self._req("GET", "")
        if st != 200:
            raise ApiError(502, "GitHub storage: cannot access the repo (check GITHUB_TOKEN and GITHUB_REPO).")
        st, ref = self._req("GET", f"/git/ref/heads/{repo['default_branch']}")
        if st == 200:
            self._req("POST", "/git/refs", {"ref": f"refs/heads/{self.branch}", "sha": ref["object"]["sha"]})

    def _fetch(self, sid):
        st, f = self._req("GET", f"/contents/snapshots/{safe_id(sid)}.json?ref={self.branch}")
        if st != 200:
            return None
        return [json.loads(base64.b64decode(f["content"]).decode("utf-8")), f["sha"]]

    def _load(self):
        if self.docs is not None:
            return
        self._ensure_branch()
        docs = {}
        st, listing = self._req("GET", f"/contents/snapshots?ref={self.branch}")
        if st == 200:
            for f in listing:
                if f["name"].endswith(".json"):
                    got = self._fetch(f["name"][:-5])
                    if got:
                        docs[f["name"][:-5]] = got
        elif st != 404:
            raise ApiError(502, f"GitHub storage error (HTTP {st}).")
        self.docs = docs

    def get(self, sid):
        with self.lock:
            self._load()
            hit = self.docs.get(safe_id(sid))
            return json.loads(json.dumps(hit[0])) if hit else None

    def put(self, sid, doc):
        sid = safe_id(sid)
        with self.lock:
            self._load()
            for attempt in range(2):
                body = {"message": f"snapshot {sid}", "branch": self.branch,
                        "content": base64.b64encode(json.dumps(doc, indent=1).encode()).decode()}
                if sid in self.docs:
                    body["sha"] = self.docs[sid][1]
                st, res = self._req("PUT", f"/contents/snapshots/{sid}.json", body)
                if st in (200, 201):
                    self.docs[sid] = [doc, res["content"]["sha"]]
                    return
                if st in (409, 422) and attempt == 0:  # stale sha: refresh and retry once
                    got = self._fetch(sid)
                    if got:
                        self.docs[sid] = got
                    else:
                        self.docs.pop(sid, None)
                    continue
                raise ApiError(502, f"GitHub storage: could not save snapshot (HTTP {st}).")

    def delete(self, sid):
        sid = safe_id(sid)
        with self.lock:
            self._load()
            hit = self.docs.pop(sid, None)
            if hit:
                self._req("DELETE", f"/contents/snapshots/{sid}.json",
                          {"message": f"untrack {sid}", "sha": hit[1], "branch": self.branch})

    def all(self):
        with self.lock:
            self._load()
            return [json.loads(json.dumps(d)) for d, _ in self.docs.values()]


STORE = GitHubStore(GITHUB_REPO, GITHUB_TOKEN, GITHUB_BRANCH) if GITHUB_TOKEN and GITHUB_REPO else FileStore()


def load_snapshots(steam64):
    return STORE.get(steam64) or {"steam64": steam64, "name": None, "snapshots": []}


def record_snapshot(s):
    fc, lt, o = s["faceit"], s["leetify"], s["overall"] or {}
    snap = {
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "faceit_elo": fc.get("elo") if fc.get("available") else None,
        "faceit_level": fc.get("level") if fc.get("available") else None,
        "faceit_matches": (fc.get("lifetime") or {}).get("matches") if fc.get("available") else None,
        "premier": (lt.get("ranks") or {}).get("premier") if lt.get("available") else None,
        "leetify_rating": (lt.get("ranks") or {}).get("leetify") if lt.get("available") else None,
        "aim": (lt.get("rating") or {}).get("aim") if lt.get("available") else None,
        "positioning": (lt.get("rating") or {}).get("positioning") if lt.get("available") else None,
        "utility": (lt.get("rating") or {}).get("utility") if lt.get("available") else None,
        "leetify_matches": lt.get("total_matches") if lt.get("available") else None,
        "kd": o.get("kd"), "adr": o.get("adr"), "winrate": o.get("winrate"), "score": s.get("score"),
    }
    doc = load_snapshots(s["steam64"])
    doc["name"] = s["identity"]["name"]
    doc["avatar"] = s["identity"]["avatar"]
    snaps = doc["snapshots"]
    # one snapshot per 10 minutes is plenty; newer lookups replace the last one
    if snaps and (datetime.now(timezone.utc) - datetime.fromisoformat(snaps[-1]["ts"].replace("Z", "+00:00"))) < timedelta(minutes=10):
        snaps[-1] = snap
    else:
        snaps.append(snap)
    STORE.put(s["steam64"], doc)
    return doc


def tracked_players():
    out = []
    for d in STORE.all():
        try:
            last = d["snapshots"][-1] if d["snapshots"] else {}
            out.append({"steam64": d["steam64"], "name": d.get("name"), "avatar": d.get("avatar"),
                        "last": last.get("ts"), "elo": last.get("faceit_elo"), "premier": last.get("premier"),
                        "count": len(d["snapshots"])})
        except (KeyError, TypeError):
            pass
    out.sort(key=lambda p: p["last"] or "", reverse=True)
    return out


# ------------------------------------------------------------------ demo ---

DEMO_STEAM64 = "76561190000000000"


DEMO_UTIL = {"de_anubis": 0.5, "de_nuke": 0.9}  # demo player's utility is weak on Anubis
DEMO_T_SIDE = {"de_nuke": -0.035}  # ...and their T side is weak on Nuke


def demo_multi(rnd, kills):
    """Rounds with 1..5 kills that add up to the match's kills."""
    m = [0, rnd.randint(1, 4), rnd.randint(0, 2), int(rnd.random() < 0.12), int(rnd.random() < 0.02)]
    while sum((i + 1) * n for i, n in enumerate(m)) > kills:
        top = max(i for i, n in enumerate(m) if n)
        m[top] -= 1
    m[0] = kills - sum((i + 1) * n for i, n in enumerate(m))
    return m


def demo_detail(rnd, mp, rounds):
    """Utility/trade/accuracy fields of a demo match, in Leetify's per-match shape."""
    u = DEMO_UTIL.get(mp, 1.0)
    clamp = lambda v, lo, hi: max(lo, min(hi, v))
    flashes = max(1, round(rounds * (0.25 + 0.25 * u) + rnd.gauss(0, 1.2)))
    trade_opps = max(1, round(rounds * 0.3 + rnd.gauss(0, 1)))
    traded_opps = max(1, round(rounds * 0.25 + rnd.gauss(0, 1)))
    return {
        "flashbang_thrown": flashes,
        "flashbang_hit_foe": round(flashes * clamp(0.5 * u + rnd.gauss(0, 0.08), 0.05, 1.2)),
        "flashbang_hit_friend": round(flashes * clamp(0.25 + (1 - u) * 0.5 + rnd.gauss(0, 0.08), 0, 1)),
        "flashbang_leading_to_kill": round(flashes * clamp(0.12 * u + rnd.gauss(0, 0.04), 0, 0.5)),
        "he_thrown": max(0, round(rounds * 0.2 * u + rnd.gauss(0, 1))),
        "he_foes_damage_avg": round(clamp(14 * u + rnd.gauss(0, 3), 0, 40), 1),
        "molotov_thrown": max(0, round(rounds * 0.2 * u + rnd.gauss(0, 1))),
        "smoke_thrown": max(0, round(rounds * 0.45 * u + rnd.gauss(0, 1.5))),
        "utility_on_death_avg": round(clamp(180 + (1 - u) * 400 + rnd.gauss(0, 40), 0, 900), 1),
        "trade_kill_opportunities": trade_opps,
        "trade_kills_succeed": round(trade_opps * clamp(0.55 + rnd.gauss(0, 0.12), 0, 1)),
        "traded_death_opportunities": traded_opps,
        "traded_deaths_succeed": round(traded_opps * clamp(0.4 + rnd.gauss(0, 0.12), 0, 1)),
        "rounds_survived": max(0, round(rounds * clamp(0.3 + rnd.gauss(0, 0.07), 0, 1))),
        "accuracy_head": clamp(0.21 + rnd.gauss(0, 0.04), 0, 1),
        "accuracy_enemy_spotted": clamp(0.36 + rnd.gauss(0, 0.05), 0, 1),
        "spray_accuracy": clamp(0.39 + rnd.gauss(0, 0.08), 0, 1),
        "counter_strafing_shots_good_ratio": clamp(0.82 + rnd.gauss(0, 0.06), 0, 1),
    }


def demo_raw():
    """Synthetic data in the same shape as the real APIs, so demo exercises the full pipeline."""
    rnd = random.Random(42)
    maps = ["de_mirage", "de_inferno", "de_ancient", "de_nuke", "de_anubis", "de_dust2", "de_train"]
    skill = {"de_mirage": 0.15, "de_inferno": 0.08, "de_ancient": 0.0, "de_nuke": -0.12, "de_anubis": 0.05, "de_dust2": 0.1, "de_train": -0.05}
    now = datetime.now(timezone.utc)
    l_matches, l_recent, f_items = [], [], []
    premier, elo = 16480, 1785
    for i in range(100):
        when = now - timedelta(hours=i * 19 + rnd.randint(0, 6))
        mp = rnd.choice(maps)
        trend = (100 - i) / 100 * 0.12  # gets better over time
        form = skill[mp] + trend + rnd.gauss(0, 0.25)
        rounds = rnd.randint(16, 25)  # MR12: 13 wins, loser max 12
        win = form + rnd.gauss(0, 0.3) > -0.1
        my, op = (13, max(0, rounds - 13)) if win else (max(0, rounds - 13), 13)
        kills = max(3, int(rounds * (0.72 + form * 0.5) + rnd.gauss(0, 2)))
        deaths = max(4, int(rounds * (0.68 - form * 0.3) + rnd.gauss(0, 2)))
        hs = int(kills * min(0.75, max(0.2, 0.47 + rnd.gauss(0, 0.1))))
        src = rnd.choices(["faceit", "matchmaking", "matchmaking_competitive"], [0.55, 0.35, 0.1])[0]
        rating = form * 0.04
        mid = f"demo-{i:03d}"
        fid = f"1-demo-{i:03d}" if src == "faceit" else None
        mk = demo_multi(rnd, kills)
        l_matches.append({
            "id": mid, "finished_at": when.isoformat().replace("+00:00", "Z"), "data_source": src,
            "data_source_match_id": fid, "map_name": mp, "has_banned_player": False,
            "team_scores": [{"team_number": 2, "score": my}, {"team_number": 3, "score": op}],
            "stats": [{"steam64_id": DEMO_STEAM64, "name": "demo_player", "initial_team_number": 2,
                       "total_kills": kills, "total_deaths": deaths, "total_assists": rnd.randint(1, 7),
                       "total_hs_kills": hs, "dpr": round(kills / rounds * 112 + rnd.gauss(0, 6), 1),
                       "rounds_count": my + op, "leetify_rating": rating,
                       "ct_leetify_rating": rating + rnd.gauss(0, 0.02),
                       "t_leetify_rating": rating + DEMO_T_SIDE.get(mp, 0) + rnd.gauss(0, 0.02),
                       "preaim": round(7.5 - trend * 10 + rnd.gauss(0, 1), 2), "reaction_time": 0.55 - trend * 0.4 + rnd.gauss(0, 0.04),
                       **{f"multi{j + 1}k": mk[j] for j in range(5)},
                       **demo_detail(rnd, mp, my + op)}],
        })
        # walking back in time: ratings were lower in the past
        rank = None
        if src == "matchmaking":
            rank = int(premier - i * 22 + rnd.gauss(0, 180))
        elif src == "faceit":
            rank = 8 if elo - i * 2 >= 1701 else 7
        l_recent.append({"id": mid, "finished_at": l_matches[-1]["finished_at"], "data_source": src, "rank": rank,
                         "rank_type": 11 if src == "matchmaking" else None, "map_name": mp})
        if src == "faceit":
            f_items.append({"stats": {"Match Id": fid, "Map": mp, "Kills": str(kills), "Deaths": str(deaths), "Assists": "3",
                                      "ADR": str(round(kills / rounds * 112, 1)), "Headshots %": str(round(100 * hs / kills)),
                                      "Result": "1" if win else "0", "Score": f"{my} / {op}", "Rounds": str(my + op),
                                      "Double Kills": str(mk[1]), "Triple Kills": str(mk[2]), "Quadro Kills": str(mk[3]), "Penta Kills": str(mk[4]),
                                      "Match Finished At": int(when.timestamp() * 1000)}})
    leetify = {"available": True, "errors": [], "matches": l_matches, "profile": {
        "privacy_mode": "public", "winrate": 0.54, "total_matches": 812, "first_match_date": "2023-09-27T18:00:00Z",
        "name": "demo_player", "bans": [], "steam64_id": DEMO_STEAM64,
        "ranks": {"leetify": 1.42, "premier": 16480, "faceit": 8, "faceit_elo": 1785, "wingman": 14, "renown": None,
                  "competitive": [{"map_name": "de_mirage", "rank": 15}, {"map_name": "de_inferno", "rank": 13}, {"map_name": "de_nuke", "rank": 11}]},
        "rating": {"aim": 71.4, "positioning": 58.2, "utility": 37.9, "clutch": 0.031, "opening": -0.024, "ct_leetify": 0.021, "t_leetify": 0.008},
        "stats": {"accuracy_enemy_spotted": 36.1, "accuracy_head": 21.4, "counter_strafing_good_shots_ratio": 82.5,
                  "ct_opening_aggression_success_rate": 61.2, "ct_opening_duel_success_percentage": 52.4,
                  "flashbang_hit_foe_avg_duration": 2.1, "flashbang_hit_foe_per_flashbang": 0.42, "flashbang_hit_friend_per_flashbang": 0.64,
                  "flashbang_leading_to_kill": 4.2, "flashbang_thrown": 11.3, "he_foes_damage_avg": 6.8, "he_friends_damage_avg": 1.9,
                  "preaim": 6.4, "reaction_time_ms": 498, "spray_accuracy": 38.7, "t_opening_aggression_success_rate": 48.9,
                  "t_opening_duel_success_percentage": 44.1, "traded_deaths_success_percentage": 39.2,
                  "trade_kill_opportunities_per_round": 0.31, "trade_kills_success_percentage": 58.3, "utility_on_death_avg": 342.1},
        "recent_matches": l_recent, "recent_teammates": []}}
    faceit = {"available": True, "errors": [], "matches": f_items,
              "player": {"player_id": "demo", "nickname": "demo_player", "avatar": "", "country": "dk",
                         "faceit_url": "https://www.faceit.com/{lang}/players/demo_player",
                         "games": {"cs2": {"faceit_elo": 1785, "skill_level": 8, "game_player_id": DEMO_STEAM64, "region": "EU"}}},
              "stats": {"lifetime": {"Matches": "642", "Wins": "347", "Win Rate %": "54", "Average K/D Ratio": "1.12",
                                     "Average Headshots %": "48", "ADR": "81.4", "Current Win Streak": "2", "Longest Win Streak": "9",
                                     "Entry Success Rate": "0.47", "Utility Damage per Round": "6.1", "Flash Success Rate": "0.41",
                                     "1v1 Win Rate": "0.58", "1v2 Win Rate": "0.24", "Sniper Kill Rate": "0.06",
                                     "Recent Results": ["1", "1", "0", "1", "0"]},
                        "segments": [{"type": "Map", "mode": "5v5", "label": m, "stats": {
                            "Matches": str(rnd.randint(40, 140)), "Win Rate %": str(round(52 + skill[m] * 60)),
                            "Average K/D Ratio": str(round(1.1 + skill[m], 2)), "Average Headshots %": str(rnd.randint(42, 52)),
                            "ADR": str(round(80 + skill[m] * 40, 1))}} for m in maps]}}
    return faceit, leetify


def demo_history():
    rnd = random.Random(7)
    now = datetime.now(timezone.utc)
    snaps, elo, prem, lr = [], 1520, 13900, -0.6
    for i in range(30, 0, -1):
        elo += rnd.randint(-25, 40)
        prem += rnd.randint(-250, 380)
        lr += rnd.gauss(0.07, 0.25)
        snaps.append({"ts": (now - timedelta(days=i * 3)).isoformat().replace("+00:00", "Z"), "faceit_elo": elo,
                      "faceit_level": min(10, (elo - 500) // 150 + 1), "premier": prem, "leetify_rating": round(lr, 2),
                      "aim": round(60 + (30 - i) * 0.35 + rnd.gauss(0, 1.5), 1), "positioning": round(52 + (30 - i) * 0.2 + rnd.gauss(0, 1.5), 1),
                      "utility": round(35 + (30 - i) * 0.1 + rnd.gauss(0, 1.5), 1), "kd": round(1.0 + (30 - i) * 0.004 + rnd.gauss(0, 0.04), 2),
                      "adr": round(76 + (30 - i) * 0.15 + rnd.gauss(0, 2), 1), "winrate": round(50 + rnd.gauss(2, 3), 1)})
    return snaps


# ----------------------------------------------------------------- views ---

def lookup(q):
    cfg = load_config()
    if q.strip().lower() == "demo":
        fr, lr = demo_raw()
        s = build_summary(normalize_faceit(fr), normalize_leetify(lr, DEMO_STEAM64), DEMO_STEAM64)
        s["demo"] = True
        s["history"] = demo_history()
        return s
    ident = resolve_query(q, cfg)
    fr = fetch_faceit(ident, cfg)
    fc = normalize_faceit(fr)
    steam64 = ident["steam64"] or (fc.get("steam64") if fc.get("available") else None)
    if not steam64:
        raise ApiError(404, f'FACEIT account "{fc.get("nickname")}" has no CS2 profile linked.' if fc.get("available")
                       else fc.get("reason") or "Could not determine the player's Steam64 ID.")
    lt = normalize_leetify(fetch_leetify(steam64, cfg), steam64)
    if not fc.get("available") and not lt.get("available"):
        raise ApiError(404, f"No data. FACEIT: {fc.get('reason')}  Leetify: {lt.get('reason')}")
    s = build_summary(fc, lt, steam64)
    s["history"] = record_snapshot(s)["snapshots"]
    return s


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print("  " + fmt % args)

    def send_json(self, obj, status=200):
        body = json.dumps(obj, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authorized(self):
        if not APP_PASSWORD:
            return True
        h = self.headers.get("Authorization", "")
        if h.startswith("Basic "):
            try:
                _, _, pw = base64.b64decode(h[6:]).decode("utf-8").partition(":")
                if hmac.compare_digest(pw.encode(), APP_PASSWORD.encode()):
                    return True
            except ValueError:
                pass
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="CS2 Tracker", charset="UTF-8"')
        self.send_header("Content-Length", "0")
        self.end_headers()
        return False

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(u.query)
        if u.path == "/healthz":  # for the host's health check; reveals nothing
            return self.send_json({"ok": True})
        if not self.authorized():
            return
        try:
            if u.path == "/api/player":
                return self.send_json(lookup(qs.get("q", [""])[0]))
            if u.path == "/api/tracked":
                return self.send_json(tracked_players())
            if u.path == "/api/config":
                c = load_config()
                return self.send_json({"faceit": bool(c["faceit_api_key"]), "leetify": bool(c["leetify_api_key"]), "locked": CONFIG_LOCKED})
        except ApiError as e:
            return self.send_json({"error": str(e)}, e.status if 400 <= e.status < 600 else 502)
        except Exception as e:  # keep the UI informative instead of hanging
            return self.send_json({"error": f"Internal error: {e}"}, 500)
        self.serve_static(u.path)

    def do_POST(self):
        if not self.authorized():
            return
        u = urllib.parse.urlparse(self.path)
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self.send_json({"error": "Invalid JSON"}, 400)
        if u.path == "/api/config":
            if CONFIG_LOCKED:
                return self.send_json({"error": "API keys are set by the server's environment variables."}, 403)
            c = save_config(body)
            with _lock:
                _cache.clear()
            return self.send_json({"faceit": bool(c["faceit_api_key"]), "leetify": bool(c["leetify_api_key"]), "locked": CONFIG_LOCKED})
        if u.path == "/api/untrack":
            try:
                STORE.delete(str(body.get("steam64", "")))
            except ApiError as e:
                return self.send_json({"error": str(e)}, 502)
            return self.send_json({"ok": True})
        self.send_json({"error": "Not found"}, 404)

    def serve_static(self, path):
        path = "/index.html" if path in ("", "/") else path
        full = os.path.normpath(os.path.join(STATIC, path.lstrip("/")))
        if not full.startswith(STATIC) or not os.path.isfile(full):
            return self.send_json({"error": "Not found"}, 404)
        ctype = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
                 ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml"}.get(os.path.splitext(full)[1], "application/octet-stream")
        with open(full, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-cache")  # always revalidate, so edits show up without a hard refresh
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"CS2 Tracker running on http://{HOST}:{PORT}  (Ctrl+C to stop)")
    print(f"  storage: {'GitHub ' + GITHUB_REPO + '@' + GITHUB_BRANCH if isinstance(STORE, GitHubStore) else 'local files'}"
          f" | password: {'on' if APP_PASSWORD else 'off'} | keys: {'env only' if CONFIG_LOCKED else 'editable'}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
