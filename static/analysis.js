/* CS2 Tracker - analysis on top of a player summary (works with both the
 * Python server and the in-browser engine, which return the same JSON).
 *
 *  - Analysis.integrity(d): statistical anomaly indicators. These are NOT proof
 *    of cheating - talented players produce outliers too; only FACEIT/Valve
 *    anti-cheat can establish cheating.
 *  - Analysis.mapCoaching(d): per-map strengths/weaknesses vs the player's own
 *    other maps, turned into concrete tips.
 *  - Analysis.coachingPlan(d, coach): ranked priorities across all maps.
 *  - Analysis.role(d): statistical role estimate.
 *
 * Everything works from Leetify data where it exists and falls back to FACEIT's
 * own match stats (utility, flashes, entries, clutches, sniper kills) for
 * players without a Leetify profile. Aim data (preaim, reaction time) only
 * exists in Leetify; neither API exposes positions/rotations.
 */
"use strict";

const Analysis = (() => {
  const mean = (xs) => { const v = xs.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
  const ratio = (a, b) => (b ? a / b : null);
  const r1 = (v) => (Math.abs(v) < 0.05 ? 0 : v).toFixed(1); // no "-0.0"
  const frac = (v) => (v == null ? null : v > 1 ? v / 100 : v); // FACEIT rates come as 0-1 or as %

  /** FACEIT's extended stats for a match: its own (FACEIT-only match) or attached to the Leetify record. */
  const fxOf = (m) => m.fx || m.faceit_stats?.fx || null;

  /** HLTV Rating 1.0 for a FACEIT match from FACEIT's stats (FACEIT has no official per-match rating).
   *  (KPR/0.679 + 0.7 * survival/0.317 + multi-kill rating/1.277) / 2.7 */
  function faceitRating(m) {
    if (m.source !== "faceit") return null;
    const s = m.faceit_stats || m; // FACEIT's own numbers when we have them, else Leetify's record of the FACEIT match
    const r = s.rounds, mk = s.multi;
    if (!r || !mk || mk.length < 5) return null;
    const kpr = s.kills / r, survival = (r - s.deaths) / r;
    const multi = (mk[0] + 4 * mk[1] + 9 * mk[2] + 16 * mk[3] + 25 * mk[4]) / r;
    return (kpr / 0.679 + (0.7 * survival) / 0.317 + multi / 1.277) / 2.7;
  }

  /* --------------------------------------------------------- integrity --- */
  // Reference: a top professional's Leetify profile (s1mple, observed Oct 2026) averaged
  // ~5.8° preaim, ~417 ms reaction time and ~24% head accuracy. Thresholds sit beyond that.
  // FACEIT-only checks use headshot %, which for most players sits around 40-55%.
  const PRO_REF = { preaim: 5.8, reaction: 417, head: 23.8 };
  const T = { preaim: 4.5, reaction: 370, head: 30, matchPreaim: 3.0, matchReaction: 300, extremeShare: 0.25,
    lifeHs: 68, matchHs: 80, matchHsKills: 15, hsShare: 0.2 };

  function integrity(d) {
    const lt = d.leetify || {}, st = lt.stats || {}, fc = d.faceit || {}, items = [];
    const add = (status, label, value, ref, detail, matches) => items.push({ status, label, value, ref, detail, matches });
    if (!lt.available && !fc.available) return { available: false, reason: "Needs Leetify or FACEIT data." };

    // 1. bans on record
    if (fc.available && fc.bans) {
      if (fc.bans.length) add("flag", "FACEIT ban on record", fc.bans.map((b) => [b.reason, b.type].filter(Boolean).join(" – ") || "ban").join("; "), "none", "Listed by FACEIT for this account.");
      else add("ok", "FACEIT bans on record", "none", "none");
    }
    if (lt.available) {
      if ((lt.bans || []).length) add("flag", "Platform ban on record", lt.bans.map((b) => b.platform).join(", "), "none", "Leetify lists a ban on one of this player's linked platform accounts.");
      else add("ok", "Platform bans on record (Leetify)", "none", "none");
    }

    // 2-4. lifetime aim averages vs a top-pro reference (Leetify)
    if (lt.available) {
      const lifetime = [
        ["Average crosshair placement (preaim)", st.preaim, (v) => `${v.toFixed(1)}°`, (v) => v < T.preaim, `top pro ≈ ${PRO_REF.preaim}°; outlier below ${T.preaim}°`],
        ["Average reaction time", st.reaction_time_ms, (v) => `${Math.round(v)} ms`, (v) => v < T.reaction, `top pro ≈ ${PRO_REF.reaction} ms; outlier below ${T.reaction} ms`],
        ["Head accuracy", st.accuracy_head, (v) => `${v.toFixed(1)}%`, (v) => v > T.head, `top pro ≈ ${PRO_REF.head}%; outlier above ${T.head}%`],
      ];
      for (const [label, v, f, isOut, ref] of lifetime) if (v != null) add(isOut(v) ? "outlier" : "ok", label, f(v), ref);
    }

    // 5. share of individual matches with extreme aim values (Leetify)
    const ms = (d.matches || []).filter((m) => m.aim_preaim != null || m.reaction_ms != null);
    if (ms.length >= 10) {
      const extreme = ms.filter((m) => (m.aim_preaim != null && m.aim_preaim < T.matchPreaim) || (m.reaction_ms != null && m.reaction_ms < T.matchReaction));
      const share = extreme.length / ms.length;
      add(share > T.extremeShare ? "outlier" : extreme.length ? "note" : "ok", "Matches with extreme aim values",
        `${extreme.length} of ${ms.length}`, `preaim < ${T.matchPreaim}° or reaction < ${T.matchReaction} ms; outlier above ${Math.round(T.extremeShare * 100)}% of matches`,
        null, extreme.map((m) => ({ ...m, extremePreaim: m.aim_preaim != null && m.aim_preaim < T.matchPreaim,
          extremeReaction: m.reaction_ms != null && m.reaction_ms < T.matchReaction })));
    }

    // 6. sudden improvement in aim: recent matches vs older ones (newest first)
    if (ms.length >= 30) {
      const recent = ms.slice(0, 15), older = ms.slice(15);
      const pr = mean(recent.map((m) => m.aim_preaim)), po = mean(older.map((m) => m.aim_preaim));
      const rr = mean(recent.map((m) => m.reaction_ms)), ro = mean(older.map((m) => m.reaction_ms));
      if (pr != null && po != null && rr != null && ro != null) {
        const pGain = (po - pr) / po, rGain = (ro - rr) / ro; // positive = better
        const both = pGain >= 0.3 && rGain >= 0.2, one = pGain >= 0.3 || rGain >= 0.2;
        add(both ? "outlier" : one ? "note" : "ok", "Sudden aim improvement (last 15 vs earlier)",
          `preaim ${po.toFixed(1)}° → ${pr.toFixed(1)}°, reaction ${Math.round(ro)} → ${Math.round(rr)} ms`,
          "outlier if preaim improves ≥30% and reaction ≥20% together");
      }
    }

    // FACEIT: headshot % and K/D signals (available without Leetify)
    const fm = (d.matches || []).filter((m) => m.source === "faceit" && m.hs_pct != null && m.kills != null);
    const life = fc.available ? fc.lifetime || {} : {};
    if (life.hs != null && (life.matches || 0) >= 50)
      add(life.hs > T.lifeHs ? "outlier" : "ok", "FACEIT lifetime headshot %", `${Math.round(life.hs)}%`, `most players ≈ 40–55%; outlier above ${T.lifeHs}%`);
    if (fm.length >= 10) {
      const extreme = fm.filter((m) => m.hs_pct >= T.matchHs && m.kills >= T.matchHsKills);
      const share = extreme.length / fm.length;
      add(share > T.hsShare ? "outlier" : extreme.length ? "note" : "ok", "FACEIT matches with extreme headshot %",
        `${extreme.length} of ${fm.length}`, `≥ ${T.matchHs}% headshots with ≥ ${T.matchHsKills} kills; outlier above ${Math.round(T.hsShare * 100)}% of matches`,
        null, extreme.map((m) => ({ ...m, extremeHs: true })));
    }
    if (fm.length >= 30) {
      const recent = fm.slice(0, 10), older = fm.slice(10);
      const kd = (xs) => ratio(sum(xs.map((m) => m.kills)), sum(xs.map((m) => m.deaths)));
      const hsR = mean(recent.map((m) => m.hs_pct)), hsO = mean(older.map((m) => m.hs_pct)), kdR = kd(recent), kdO = kd(older);
      if (hsR != null && hsO != null && kdR != null && kdO != null) {
        const hsJump = hsR - hsO >= 15, kdJump = kdR - kdO >= 0.4;
        add(hsJump && kdJump ? "outlier" : hsJump || kdJump ? "note" : "ok", "Sudden jump on FACEIT (last 10 vs earlier)",
          `HS ${Math.round(hsO)}% → ${Math.round(hsR)}%, K/D ${kdO.toFixed(2)} → ${kdR.toFixed(2)}`, "outlier if HS% rises ≥15 points and K/D ≥0.4 together");
      }
    }
    const level = fc.available ? fc.level : lt.ranks?.faceit;
    const last20 = fm.slice(0, 20);
    if (level && last20.length >= 10) {
      const kd20 = ratio(sum(last20.map((m) => m.kills)), sum(last20.map((m) => m.deaths)));
      if (kd20 != null) add(kd20 >= 1.6 && level <= 4 ? "note" : "ok", "K/D vs FACEIT level", `K/D ${kd20.toFixed(2)} at level ${level}`, "unusual: K/D ≥ 1.6 over 20 matches at level 4 or below (smurf or fast improver)");
    }

    // 7. mechanical skill out of line with rank (Leetify aim rating)
    const aim = lt.rating?.aim, premier = lt.ranks?.premier;
    if (aim != null && (premier || level)) {
      const lowRank = (premier ? premier < 12000 : true) && (level ? level <= 5 : true);
      add(aim >= 90 && lowRank ? "note" : "ok", "Aim rating vs rank",
        `aim ${aim.toFixed(0)}${premier ? ` · Premier ${Math.round(premier).toLocaleString()}` : ""}${level ? ` · FACEIT lvl ${level}` : ""}`,
        "unusual: aim ≥ 90 with Premier < 12,000 and FACEIT ≤ 5");
    }

    // 8. very new profile with elite aim
    if (lt.first_match && aim != null) {
      const days = (Date.now() - new Date(lt.first_match).getTime()) / 86400e3;
      add(days < 120 && aim >= 85 ? "note" : "ok", "Account history",
        `first Leetify match ${Math.round(days)} days ago`, "unusual: under 120 days of history with aim ≥ 85");
    }

    // context only: matches where someone (teammate or opponent) was later banned
    const banned = (d.matches || []).filter((m) => m.has_banned_player).length;
    const context = banned ? `${banned} of the last ${d.matches.length} matches included a player who was later banned (could be a teammate or an opponent – not evidence about this player).` : null;
    const missing = lt.available ? null : "No Leetify profile, so aim statistics (crosshair placement, reaction time) aren't available – these checks use FACEIT's headshot, K/D and ban data instead.";

    const outliers = items.filter((i) => i.status === "outlier").length, flags = items.filter((i) => i.status === "flag").length;
    const notes = items.filter((i) => i.status === "note").length;
    const level_ = flags ? "flag" : outliers >= 2 ? "high" : outliers || notes ? "some" : "none";
    const verdict = {
      none: "No statistical anomalies – everything is within what strong legitimate players produce.",
      some: "A few unusual values. On their own these are common among talented players.",
      high: "Several values beyond the references at the same time. Worth a closer look at demos – still not proof.",
      flag: "A ban is on record for this player.",
    }[level_];
    return { available: true, level: level_, verdict, items, context, missing, counts: { outliers, notes, flags } };
  }

  /* ------------------------------------------------------- map coaching --- */
  /** Totals over the matches where both a and b are known (so ratios compare like with like). */
  function pairSum(rows, fa, fb) {
    let a = 0, b = 0, n = 0;
    for (const m of rows) { const x = fa(m), y = fb(m); if (x != null && y != null && !Number.isNaN(x) && !Number.isNaN(y)) { a += x; b += y; n++; } }
    return n ? { a, b, n } : null;
  }

  function profile(ms) {
    const rows = ms.filter((m) => m.rounds);
    if (!rows.length) return null;
    const ex = rows.filter((m) => m.ext);
    const e = (k) => ex.map((m) => m.ext[k]);
    const per = (f) => { const s = pairSum(rows, f, (m) => m.rounds); return s ? s.a / s.b : null; };
    const util = (m) => (m.ext ? (m.ext.flash_thrown || 0) + (m.ext.he_thrown || 0) + (m.ext.molotov_thrown || 0) + (m.ext.smoke_thrown || 0) : fxOf(m)?.util_count);
    const flashes = (m) => (m.ext ? m.ext.flash_thrown : fxOf(m)?.flash_count);
    const blinded = (m) => (m.ext ? m.ext.flash_foe : fxOf(m)?.enemies_flashed);
    const fl = pairSum(rows, blinded, flashes);
    const heThrown = sum(e("he_thrown"));
    const entries = pairSum(rows, (m) => fxOf(m)?.entry_wins, (m) => fxOf(m)?.entry_count);
    const clutch = pairSum(rows, (m) => fxOf(m)?.v1_wins, (m) => fxOf(m)?.v1_count);
    const decided = ms.filter((m) => m.outcome === "win" || m.outcome === "loss");
    const k = sum(ms.map((m) => m.kills)), dth = sum(ms.map((m) => m.deaths));
    const exRounds = sum(ex.map((m) => m.rounds));
    return {
      n: ms.length,
      winrate: decided.length ? (100 * decided.filter((m) => m.outcome === "win").length) / decided.length : null,
      rating: mean(ms.map((m) => m.rating)), frating: mean(ms.map(faceitRating)),
      ct: mean(ms.map((m) => m.ct_rating)), t: mean(ms.map((m) => m.t_rating)),
      kd: ratio(k, dth), adr: mean(ms.map((m) => m.adr)), kpr: per((m) => m.kills), apr: per((m) => m.assists),
      util_pr: per(util),
      // grenade efficiency needs a minimum sample, or a couple of throws decide the tip
      flash_eff: fl && fl.b >= 10 ? fl.a / fl.b : null,
      blinded_pr: per(blinded),
      flash_team: ex.length && sum(e("flash_thrown")) >= 10 ? ratio(sum(e("flash_friend")), sum(e("flash_thrown"))) : null,
      he_dmg: heThrown >= 5 ? ratio(sum(ex.map((m) => (m.ext.he_dmg_avg || 0) * (m.ext.he_thrown || 0))), heThrown) : null,
      util_dmg: per((m) => fxOf(m)?.util_dmg), // FACEIT: utility damage per round
      util_death: mean(e("util_on_death")),
      trade: ratio(100 * sum(e("trade_succ")), sum(e("trade_opps"))),
      traded: ratio(100 * sum(e("traded_succ")), sum(e("traded_opps"))),
      trade_opp_pr: ex.length ? ratio(sum(e("trade_opps")), exRounds) : null,
      traded_opp_pr: ex.length ? ratio(sum(e("traded_opps")), exRounds) : null,
      survival: (() => { const v = per((m) => (m.ext?.survived != null ? m.ext.survived : m.deaths != null ? Math.max(0, m.rounds - m.deaths) : null)); return v == null ? null : 100 * v; })(),
      entry_rate: per((m) => fxOf(m)?.entry_count),
      entry_success: entries && entries.b >= 10 ? (100 * entries.a) / entries.b : null,
      clutch_1v1: clutch && clutch.b >= 5 ? (100 * clutch.a) / clutch.b : null,
      sniper_share: (() => { const s = pairSum(rows, (m) => fxOf(m)?.sniper_kills, (m) => m.kills); return s && s.b >= 50 ? s.a / s.b : null; })(),
      preaim: mean(ms.map((m) => m.aim_preaim)),
      head: mean(e("acc_head")),
    };
  }

  // Each rule compares this map (m) with the player's other maps (o). gap = how far off, for ranking.
  const RULES = [
    { key: "util_pr", bad: (m, o) => m < o * 0.8 && o - m >= 0.1, gap: (m, o) => (o - m) / o,
      tip: (map, m, o) => `You use ${m.toFixed(2)} grenades per round on ${map} vs ${o.toFixed(2)} on your other maps. Learn 2–3 standard smokes and a molotov for each bombsite on ${map} so every round starts with a utility plan.` },
    { key: "flash_eff", bad: (m, o) => m < o * 0.75, gap: (m, o) => (o - m) / o,
      tip: (map, m, o) => `Your flashes blind ${m.toFixed(2)} enemies each on ${map} vs ${o.toFixed(2)} elsewhere – they're landing behind cover or popping too early. Practise pop-flashes for the main entrances on ${map} in a private server.` },
    { key: "flash_team", bad: (m, o) => m > o * 1.3 && m >= 0.3, gap: (m, o) => (m - o) / Math.max(o, 0.1),
      tip: (map, m, o) => `You blind teammates with ${m.toFixed(2)} per flash on ${map} (vs ${o.toFixed(2)} elsewhere). Call your flashes and throw them over teammates, not past them.` },
    { key: "util_death", bad: (m, o) => m > o * 1.25 && m >= 250, gap: (m, o) => (m - o) / o,
      tip: (map, m, o) => `You die holding $${Math.round(m)} of unused utility on average on ${map} (vs $${Math.round(o)} elsewhere). Use it earlier – a molotov on a common push or a flash before you peek.` },
    { key: "he_dmg", bad: (m, o) => m < o * 0.7 && o - m >= 3, gap: (m, o) => (o - m) / o,
      tip: (map, m, o) => `Your HE grenades do ${m.toFixed(1)} damage each on ${map} vs ${o.toFixed(1)} elsewhere. Learn where defenders/attackers usually stack on ${map} and throw HEs there, ideally together with a teammate's.` },
    { key: "util_dmg", bad: (m, o) => m < o * 0.7 && o - m >= 1, gap: (m, o) => (o - m) / o,
      tip: (map, m, o) => `Your grenades do ${m.toFixed(1)} damage per round on ${map} vs ${o.toFixed(1)} elsewhere. Learn molotov and HE lineups for the common positions on ${map}.` },
    { key: "entry_success", bad: (m, o) => m < o - 12, gap: (m, o) => (o - m) / 100,
      tip: (map, m, o) => `You win ${Math.round(m)}% of your entry duels on ${map} vs ${Math.round(o)}% elsewhere. Enter behind a flash, or let a teammate take the first contact and trade it.` },
    { key: "trade", bad: (m, o) => m < o - 12, gap: (m, o) => (o - m) / 100,
      tip: (map, m, o) => `You trade a fallen teammate ${Math.round(m)}% of the time on ${map} vs ${Math.round(o)}% elsewhere. Stay close enough to your entry player to re-peek within a second or two.` },
    { key: "traded", bad: (m, o) => m < o - 12, gap: (m, o) => (o - m) / 100,
      tip: (map, m, o) => `Only ${Math.round(m)}% of your deaths on ${map} get traded (vs ${Math.round(o)}% elsewhere) – you're dying in isolated spots. Play positions on ${map} where a teammate can swing for you.` },
    { key: "survival", bad: (m, o) => m < o - 8, gap: (m, o) => (o - m) / 100,
      tip: (map, m, o) => `You survive ${Math.round(m)}% of rounds on ${map} vs ${Math.round(o)}% elsewhere. Avoid the early, unsupported peeks – fall back after first contact more often.` },
    { key: "preaim", bad: (m, o) => m > o * 1.2 && m - o >= 1, gap: (m, o) => (m - o) / o,
      tip: (map, m, o) => `Your crosshair placement is worse on ${map} (${m.toFixed(1)}° vs ${o.toFixed(1)}°) – you're not pre-aiming the common angles yet. Run a prefire-practice map for ${map} to learn where enemies appear.` },
  ];

  function sideTip(map, p) {
    if (p.ct == null || p.t == null || Math.abs(p.ct - p.t) < 2.5) return null;
    const weakT = p.t < p.ct;
    return {
      key: weakT ? "t_side" : "ct_side", gap: Math.abs(p.ct - p.t) / 10,
      text: weakT
        ? `Your T side is the problem on ${map}: rating ${r1(p.t)} on T vs ${r1(p.ct)} on CT. Work on T-side executes – arrive with utility, trade your entry, and avoid dry peeks.`
        : `Your CT side is weaker on ${map}: rating ${r1(p.ct)} vs ${r1(p.t)} on T. Review your CT positions – play crossfires with a teammate and fall back instead of dying alone.`,
    };
  }

  const MIN_MATCHES = 5;
  const hasDetail = (m) => !!(m.ext || fxOf(m));

  // Active Duty pool (Premier / FACEIT) - tips are only given for these maps, compared with each other.
  // Default as of 6 Jul 2026, when Cache replaced Overpass in both Valve's pool and FACEIT's.
  // Viewers can override it in Settings (Analysis.setPool), so a rotation doesn't need a code change.
  const DEFAULT_POOL = ["Ancient", "Anubis", "Cache", "Dust2", "Inferno", "Mirage", "Nuke"];
  const KNOWN_MAPS = ["Ancient", "Anubis", "Cache", "Dust2", "Inferno", "Mirage", "Nuke", "Overpass", "Train", "Vertigo"];
  const norm = (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "").replace(/ii$/, "2");
  let ACTIVE_DUTY = DEFAULT_POOL, ACTIVE_SET = new Set(DEFAULT_POOL.map(norm));
  const isActiveDuty = (name) => ACTIVE_SET.has(norm(name));
  function setPool(maps) {
    ACTIVE_DUTY = Array.isArray(maps) && maps.length ? [...maps] : DEFAULT_POOL;
    ACTIVE_SET = new Set(ACTIVE_DUTY.map(norm));
  }

  function mapCoaching(d) {
    const byMap = {}, outOfPool = new Set();
    for (const m of d.matches || []) {
      if (isActiveDuty(m.map)) (byMap[m.map] ||= []).push(m);
      else outOfPool.add(m.map);
    }
    const maps = Object.keys(byMap).filter((k) => byMap[k].filter(hasDetail).length >= MIN_MATCHES);
    const base = { pool: ACTIVE_DUTY, outOfPool: [...outOfPool].sort(), minMatches: MIN_MATCHES };
    if (!maps.length) return { ...base, available: false, reason: `Needs at least ${MIN_MATCHES} matches with detailed stats (Leetify or FACEIT) on an Active Duty map (${ACTIVE_DUTY.join(", ")}).` };
    const result = maps.map((name) => {
      const p = profile(byMap[name]);
      const others = profile(Object.entries(byMap).filter(([k]) => k !== name).flatMap(([, v]) => v));
      const tips = [], strengths = [];
      if (p && others) {
        for (const r of RULES) {
          const mv = p[r.key], ov = others[r.key];
          if (mv == null || ov == null || ov === 0) continue;
          if (r.bad(mv, ov)) tips.push({ key: r.key, gap: r.gap(mv, ov), text: r.tip(name, mv, ov) });
          else if (r.bad(ov, mv)) strengths.push(r.key); // mirror: this map is clearly better
        }
        const s = sideTip(name, p);
        if (s) tips.push(s);
        const own = p.rating != null && others.rating != null ? [p.rating, others.rating] : p.frating != null && others.frating != null ? [p.frating, others.frating] : null;
        if (own && p.winrate != null && others.winrate != null && p.winrate < others.winrate - 12 && own[0] >= own[1])
          tips.push({ key: "team", gap: 0.05, text: `You lose more on ${name} (${Math.round(p.winrate)}% win rate vs ${Math.round(others.winrate)}%) even though your own rating holds up – the issue is more likely team strategy on ${name} than your individual play.` });
      }
      tips.sort((a, b) => b.gap - a.gap);
      return { map: name, stats: p, others, tips: tips.slice(0, 4), strengths };
    });
    // weakest map first: most tips, then lowest rating
    const score = (x) => x.stats?.rating ?? (x.stats?.frating != null ? (x.stats.frating - 1) * 10 : 0);
    result.sort((a, b) => b.tips.length - a.tips.length || score(a) - score(b));
    const skipped = Object.keys(byMap).filter((k) => !maps.includes(k));
    return { ...base, available: true, maps: result, skipped };
  }

  /* ------------------------------------------------------ coaching plan --- */
  // Areas of the game, each with checks against rough rule-of-thumb references (not official
  // benchmarks) and the map-coaching tip keys that point to the same problem. A problem that
  // shows up on several maps raises the area's priority. Checks marked noLeetify stand in for
  // Leetify-only stats when the player has no Leetify profile.
  const clampSev = (x) => Math.max(0.2, Math.min(2, x));
  const AREAS = [
    { id: "aim", title: "Aim & fragging", mapKeys: ["preaim"], checks: [
      { label: "Crosshair placement (preaim)", get: (c) => c.st.preaim, weak: (v) => v > 9, good: (v) => v <= 6, fmt: (v) => `${v.toFixed(1)}°`, ref: "≤ 6° good · > 9° weak", sev: (v) => (v - 9) / 3,
        action: "Keep your crosshair at head height on the next angle you'll clear – run a prefire-practice map for your main map 2–3× a week." },
      { label: "Reaction time", get: (c) => c.st.reaction_time_ms, weak: (v) => v > 600, good: (v) => v <= 500, fmt: (v) => `${Math.round(v)} ms`, ref: "≤ 500 ms good · > 600 ms weak", sev: (v) => (v - 600) / 150,
        action: "Pre-aim and hold angles instead of moving the crosshair onto targets; 10 min of reflex training (e.g. Aim Botz) as warm-up." },
      { label: "Counter-strafing", get: (c) => c.st.counter_strafing_good_shots_ratio, weak: (v) => v < 70, good: (v) => v >= 85, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 85% good · < 70% weak", sev: (v) => (70 - v) / 15,
        action: "Counter-strafe drill: tap the opposite movement key and only fire once you're fully stopped." },
      { label: "Spray accuracy", get: (c) => c.st.spray_accuracy, weak: (v) => v < 30, good: (v) => v >= 45, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 45% good · < 30% weak", sev: (v) => (30 - v) / 15,
        action: "Practise the AK/M4 spray pattern for the first 10 bullets on a wall, then in deathmatch – and burst at long range." },
      { label: "Head accuracy", get: (c) => c.st.accuracy_head, weak: (v) => v < 15, good: (v) => v >= 22, fmt: (v) => `${v.toFixed(1)}%`, ref: "≥ 22% good · < 15% weak", sev: (v) => (15 - v) / 7,
        action: "Deathmatch with headshot-only mode for 10 minutes to train head-level aim." },
      { label: "Damage per round (ADR)", noLeetify: true, get: (c) => c.o.adr, weak: (v) => v < 70, good: (v) => v >= 85, fmt: (v) => v.toFixed(1), ref: "≥ 85 good · < 70 weak", sev: (v) => (70 - v) / 10,
        action: "Warm up 10–15 minutes in deathmatch before playing, and practise peeking off-angles in a prefire map so your first bullets land." },
      { label: "K/D", noLeetify: true, get: (c) => c.o.kd, weak: (v) => v < 0.9, good: (v) => v >= 1.15, fmt: (v) => v.toFixed(2), ref: "≥ 1.15 good · < 0.9 weak", sev: (v) => (0.9 - v) / 0.15,
        action: "Take fewer 50/50 duels: peek with a flash or with a teammate, and fall back after a kill instead of re-peeking." },
    ] },
    { id: "utility", title: "Utility usage", mapKeys: ["util_pr", "flash_eff", "flash_team", "util_death", "he_dmg", "util_dmg"], checks: [
      { label: "Utility rating", get: (c) => c.lt.rating?.utility, weak: (v) => v < 45, good: (v) => v >= 65, fmt: (v) => v.toFixed(0), ref: "≥ 65 good · < 45 weak (Leetify)", sev: (v) => (45 - v) / 15,
        action: "Learn 2 smokes, 1 molotov and 1 pop-flash for each bombsite on your 3 most-played maps." },
      { label: "Grenades thrown per round", get: (c) => c.p?.util_pr, weak: (v) => v < 1.0, good: (v) => v >= 1.5, fmt: (v) => v.toFixed(2), ref: "≥ 1.5 good · < 1.0 weak", sev: (v) => (1.0 - v) / 0.4,
        action: "Buy and use a full utility set when you can afford it – every round should start with a plan for your grenades." },
      { label: "Enemies blinded per flash", get: (c) => c.st.flashbang_hit_foe_per_flashbang ?? c.p?.flash_eff, weak: (v) => v < 0.4, good: (v) => v >= 0.6, fmt: (v) => v.toFixed(2), ref: "≥ 0.6 good · < 0.4 weak", sev: (v) => (0.4 - v) / 0.2,
        action: "Throw pop-flashes that burst as they cross the angle, not behind walls – practise 2 per site in a private server." },
      { label: "Teammates blinded per flash", get: (c) => c.st.flashbang_hit_friend_per_flashbang, weak: (v) => v >= 0.6, good: (v) => v <= 0.3, fmt: (v) => v.toFixed(2), ref: "≤ 0.3 good · ≥ 0.6 weak", sev: (v) => (v - 0.6) / 0.3,
        action: "Call every flash (\"flashing A main\") and throw over your teammates, not past them." },
      { label: "Unused utility at death", get: (c) => c.st.utility_on_death_avg, weak: (v) => v >= 300, good: (v) => v <= 150, fmt: (v) => `$${Math.round(v)}`, ref: "≤ $150 good · ≥ $300 weak", sev: (v) => (v - 300) / 200,
        action: "Use your grenades before you take a fight you might lose – a molotov on a push or a flash for your own peek." },
      { label: "Utility damage per round", noLeetify: true, get: (c) => c.p?.util_dmg ?? c.fl.utility_dpr, weak: (v) => v < 3.5, good: (v) => v >= 7, fmt: (v) => v.toFixed(1), ref: "≥ 7 good · < 3.5 weak (FACEIT)", sev: (v) => (3.5 - v) / 2,
        action: "Learn molotov and HE lineups for the common positions on your main maps – utility damage wins rounds without duels." },
    ] },
    { id: "teamplay", title: "Trading & teamplay", mapKeys: ["trade", "traded"], checks: [
      { label: "Trade kill success", get: (c) => c.st.trade_kills_success_percentage, weak: (v) => v < 40, good: (v) => v >= 55, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 55% good · < 40% weak", sev: (v) => (40 - v) / 15,
        action: "When your entry player goes in, be ready to re-peek within 1–2 seconds – stay one step behind them, not across the map." },
      { label: "Deaths that get traded", get: (c) => c.st.traded_deaths_success_percentage, weak: (v) => v < 30, good: (v) => v >= 45, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 45% good · < 30% weak", sev: (v) => (30 - v) / 15,
        action: "Take fights where a teammate can swing for you; tell the team before you peek so someone is ready to trade." },
    ] },
    { id: "positioning", title: "Positioning & opening duels", mapKeys: ["survival", "entry_success"], checks: [
      { label: "Positioning rating", get: (c) => c.lt.rating?.positioning, weak: (v) => v < 45, good: (v) => v >= 65, fmt: (v) => v.toFixed(0), ref: "≥ 65 good · < 45 weak (Leetify)", sev: (v) => (45 - v) / 15,
        action: "After first contact, reposition instead of re-peeking the same angle; avoid spots with no escape route." },
      { label: "Rounds survived", get: (c) => c.p?.survival, weak: (v) => v < 25, good: (v) => v >= 35, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 35% good · < 25% weak", sev: (v) => (25 - v) / 10,
        action: "Play for information early in the round – fall back after contact more often instead of forcing the duel." },
      { label: "Opening duels won on CT", get: (c) => c.st.ct_opening_duel_success_percentage, weak: (v) => v < 45, good: (v) => v >= 55, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 55% good · < 45% weak", sev: (v) => (45 - v) / 10,
        action: "On CT, hold off-angles and use a crossfire with a teammate instead of taking the first duel alone." },
      { label: "Opening duels won on T", get: (c) => c.st.t_opening_duel_success_percentage, weak: (v) => v < 45, good: (v) => v >= 55, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 55% good · < 45% weak", sev: (v) => (45 - v) / 10,
        action: "On T, don't dry-peek for the opening kill – take it with a flash, or let your entry player take it and trade." },
      { label: "Entry duels won", noLeetify: true, get: (c) => c.p?.entry_success ?? (frac(c.fl.entry_success) != null ? 100 * frac(c.fl.entry_success) : null), weak: (v) => v < 42, good: (v) => v >= 55, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 55% good · < 42% weak (FACEIT)", sev: (v) => (42 - v) / 10,
        action: "Don't dry-peek for the opening kill – enter behind a flash, or let a teammate take first contact and trade it." },
    ] },
    { id: "rounds", title: "Clutches & round impact", mapKeys: [], checks: [
      { label: "Clutch rating", get: (c) => c.lt.rating?.clutch, weak: (v) => v < -1, good: (v) => v >= 2, fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1), ref: "≥ +2 good · < −1 weak (Leetify)", sev: (v) => (-1 - v) / 2,
        action: "In clutches, slow down: use the time, isolate one duel at a time, and play the bomb/sound instead of rushing peeks." },
      { label: "Opening rating", get: (c) => c.lt.rating?.opening, weak: (v) => v < -1, good: (v) => v >= 2, fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1), ref: "≥ +2 good · < −1 weak (Leetify)", sev: (v) => (-1 - v) / 2,
        action: "You're losing too many first duels – take opening fights only with utility or a teammate ready to trade." },
      { label: "1v1 clutches won", noLeetify: true, get: (c) => c.p?.clutch_1v1 ?? (frac(c.fl.clutch_1v1) != null ? 100 * frac(c.fl.clutch_1v1) : null), weak: (v) => v < 45, good: (v) => v >= 60, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 60% good · < 45% weak (FACEIT)", sev: (v) => (45 - v) / 10,
        action: "In clutches, slow down: use the time, isolate one duel at a time, and play the bomb/sound instead of rushing peeks." },
    ] },
  ];

  // map-coaching tip keys -> what recurs, and what to do about it
  const PATTERNS = {
    util_pr: ["Grenades used per round", "Plan your utility for each round on these maps – learn the default smokes/molotovs for both sites."],
    flash_eff: ["Enemies blinded per flash", "Practise pop-flashes for the main entrances on these maps in a private server."],
    flash_team: ["Teammates blinded per flash", "Call your flashes and throw them over teammates, not past them – especially on these maps."],
    util_death: ["Unused utility when dying", "Use your grenades earlier in the round on these maps instead of dying with them."],
    he_dmg: ["HE damage per grenade", "Learn the common stacking spots on these maps and throw HEs there, ideally together with a teammate."],
    util_dmg: ["Utility damage per round", "Learn molotov and HE lineups for the common positions on these maps."],
    entry_success: ["Entry duels won", "Enter behind a flash on these maps, or let a teammate take first contact and trade it."],
    trade: ["Trading teammates", "Stay close enough to your entry player to re-peek within a second or two."],
    traded: ["Getting traded", "Play positions where a teammate can swing for you instead of isolated spots."],
    survival: ["Rounds survived", "Fall back after first contact more often instead of forcing the duel."],
    preaim: ["Crosshair placement", "Run a prefire-practice map for these maps to learn where enemies appear."],
  };

  /** Win rate after a loss vs after a win (chronological), a simple tilt signal. */
  function tilt(ms) {
    const seq = [...ms].reverse().filter((m) => m.outcome === "win" || m.outcome === "loss");
    const after = { win: [], loss: [] };
    for (let i = 1; i < seq.length; i++) after[seq[i - 1].outcome].push(seq[i].outcome === "win");
    if (after.win.length < 8 || after.loss.length < 8) return null;
    const wr = (xs) => (100 * xs.filter(Boolean).length) / xs.length;
    return { afterWin: wr(after.win), afterLoss: wr(after.loss), n: after.loss.length };
  }

  function coachingPlan(d, coach) {
    const lt = d.leetify || {};
    const pool = (d.matches || []).filter((m) => isActiveDuty(m.map));
    const c = { lt: lt.available ? lt : {}, st: (lt.available && lt.stats) || {}, p: profile(pool.length ? pool : d.matches || []),
      fl: d.faceit?.available ? d.faceit.lifetime || {} : {}, o: d.overall || {} };
    const mapsWith = (keys) => (coach?.available ? coach.maps.filter((m) => m.tips.some((t) => keys.includes(t.key))).map((m) => m.map) : []);
    const areas = [], keep = [];

    for (const a of AREAS) {
      const evidence = [], actions = [];
      let sev = 0;
      for (const ch of a.checks) {
        if (ch.noLeetify && lt.available) continue;
        const v = ch.get(c);
        if (v == null || Number.isNaN(v)) continue;
        if (ch.weak(v)) { const s = clampSev(ch.sev(v)); sev += s; evidence.push({ label: ch.label, value: ch.fmt(v), ref: ch.ref, sev: s }); actions.push(ch.action); }
        else if (ch.good(v)) keep.push({ label: ch.label, value: ch.fmt(v) });
      }
      const maps = mapsWith(a.mapKeys);
      // the same problem on several maps is a pattern, not noise
      for (const key of a.mapKeys) {
        const on = mapsWith([key]);
        if (on.length < 2 || !PATTERNS[key]) continue;
        sev += 0.25 * on.length;
        evidence.push({ label: `${PATTERNS[key][0]} – worse than on your other maps`, value: on.join(", "), ref: `recurring on ${on.length} maps`, sev: 0, pattern: true });
        if (!actions.includes(PATTERNS[key][1])) actions.push(PATTERNS[key][1]);
      }
      if (evidence.length) areas.push({ id: a.id, title: a.title, sev, evidence: evidence.sort((x, y) => y.sev - x.sev), actions, maps });
    }

    // side balance across all maps (Leetify)
    const ct = lt.rating?.ct, t = lt.rating?.t;
    if (ct != null && t != null && Math.abs(ct - t) >= 2.5) {
      const weakT = t < ct;
      areas.push({ id: "side", title: weakT ? "T-side play" : "CT-side play", sev: clampSev(Math.abs(ct - t) / 4),
        evidence: [{ label: `${weakT ? "T" : "CT"}-side rating vs ${weakT ? "CT" : "T"}`, value: `${(weakT ? t : ct).toFixed(1)} vs ${(weakT ? ct : t).toFixed(1)}`, ref: "a gap of 2.5+ is a clear weak side" }],
        actions: weakT
          ? ["Agree on 1–2 default executes per map with your team and arrive on site with utility, not one by one.", "As a T, trade your entry player instead of lurking far away early in the round."]
          : ["On CT, play crossfires with a teammate and fall back to retake instead of dying alone on site.", "Use utility to delay pushes (molotov/HE) rather than relying on the first duel."],
        maps: mapsWith([weakT ? "t_side" : "ct_side"]) });
    }

    // mental & consistency - Leetify rating, or the FACEIT rating without Leetify
    const tl = tilt(d.matches || []);
    const lRated = (d.matches || []).filter((m) => m.rating != null);
    const fRated = (d.matches || []).map(faceitRating).filter((v) => v != null);
    const bad = lRated.length >= 15 ? { share: lRated.filter((m) => m.rating < -3).length / lRated.length, label: "Matches with a very low Leetify rating (< −3)" }
      : fRated.length >= 15 ? { share: fRated.filter((v) => v < 0.8).length / fRated.length, label: "Matches with a FACEIT rating below 0.80" } : null;
    const mental = { evidence: [], actions: [], sev: 0 };
    if (tl && tl.afterWin - tl.afterLoss >= 15) {
      mental.sev += clampSev((tl.afterWin - tl.afterLoss - 15) / 15 + 0.5);
      mental.evidence.push({ label: "Win rate after a loss vs after a win", value: `${Math.round(tl.afterLoss)}% vs ${Math.round(tl.afterWin)}%`, ref: "a 15+ point drop suggests tilt" });
      mental.actions.push("After 2 losses in a row, take a 15-minute break before queuing again.");
    }
    if (bad && bad.share > 0.3) {
      mental.sev += clampSev((bad.share - 0.3) / 0.15 + 0.3);
      mental.evidence.push({ label: bad.label, value: `${Math.round(bad.share * 100)}%`, ref: "over 30% means too many off-games" });
      mental.actions.push("Warm up for 10–15 minutes before your first match – deathmatch plus a few prefire runs.");
    }
    if (mental.evidence.length) areas.push({ id: "mental", title: "Consistency & tilt", maps: [], ...mental });

    // map pool: a clear worst map
    if (coach?.available && coach.maps.length >= 3) {
      const withWr = coach.maps.filter((m) => m.stats.winrate != null && m.stats.n >= 8);
      const worst = withWr.reduce((a, b) => (b.stats.winrate < a.stats.winrate ? b : a), withWr[0]);
      const avg = withWr.reduce((a, m) => a + m.stats.winrate * m.stats.n, 0) / withWr.reduce((a, m) => a + m.stats.n, 0);
      if (worst && avg - worst.stats.winrate >= 12)
        areas.push({ id: "mappool", title: `Weakest map: ${worst.map}`, sev: Math.min(1, clampSev((avg - worst.stats.winrate) / 30)), maps: [worst.map],
          evidence: [{ label: `Win rate on ${worst.map} vs your average`, value: `${Math.round(worst.stats.winrate)}% vs ${Math.round(avg)}%`, ref: `${worst.stats.n} matches` }],
          actions: [...(worst.tips[0] ? [worst.tips[0].text] : []),
            `Either put focused practice into ${worst.map} or make it your first ban in FACEIT veto until it improves.`] });
    }

    areas.sort((a, b) => b.sev - a.sev);
    const priorities = areas.slice(0, 3), more = areas.slice(3);
    // a short weekly routine from the top priorities' first actions
    const routine = [{ area: "Every session", text: "Warm up 10–15 minutes before your first match: deathmatch at head height, then one prefire run of the map you'll play." },
      ...priorities.flatMap((a) => a.actions.slice(0, 2).map((text) => ({ area: a.title, text })))];
    return { priorities, more, keep: keep.slice(0, 6), routine, matches: (d.matches || []).length,
      source: lt.available ? null : "No Leetify profile – this plan uses FACEIT's match stats (no aim mechanics or trade data)." };
  }

  /* ---------------------------------------------------------------- role --- */
  // A statistical estimate of the player's role (not an AI model): each role gets a 0-100 score
  // from the signals that are available, with the reasons shown. Ranges are rough references
  // calibrated on real Leetify data. AWPer needs FACEIT's sniper-kill stats (Leetify has no
  // per-weapon kills); trade signals need Leetify. Missing signals are left out of the score.
  const lin = (x, lo, hi) => (x == null || Number.isNaN(x) ? null : Math.max(0, Math.min(1, (x - lo) / (hi - lo))));
  const inv = (v) => (v == null ? null : 1 - v); // "lower is more typical" signals, keeping null = unknown
  const ROLE_INFO = {
    awper: { name: "AWPer", blurb: "Takes a large share of the team's kills with the AWP and holds long angles." },
    entry: { name: "Entry fragger", blurb: "First into the site – takes opening duels and dies where teammates can trade." },
    support: { name: "Support", blurb: "Utility-heavy: flashes and smokes for teammates, assists more than average." },
    lurker: { name: "Lurker", blurb: "Plays away from the team, catches rotations, and survives rounds alone." },
    rifler: { name: "Second rifle / trader", blurb: "Follows the entry and trades – a steady fragger who isn't first in." },
  };

  function weighted(parts) {
    const ok = parts.filter(([v]) => v != null);
    const w = ok.reduce((a, [, wt]) => a + wt, 0);
    return w >= 0.5 ? Math.round((100 * ok.reduce((a, [v, wt]) => a + v * wt, 0)) / w) : null;
  }

  function role(d) {
    const detailed = (d.matches || []).filter((m) => m.rounds && hasDetail(m));
    const faceitOnes = detailed.filter((m) => m.source === "faceit");
    const ms = faceitOnes.length >= 5 ? faceitOnes : detailed;
    const basis = faceitOnes.length >= 5 ? `${ms.length} FACEIT matches` : `${ms.length} matches (fewer than 5 detailed FACEIT matches, so all platforms)`;
    if (ms.length < 5) return { available: false, reason: "Needs at least 5 matches with detailed stats (Leetify or FACEIT) to estimate a role." };

    const p = profile(ms);
    const life = d.faceit?.available ? d.faceit.lifetime || {} : {};
    const sniperShare = p.sniper_share ?? (life.total_sniper_kills != null && life.total_kills_ext ? life.total_sniper_kills / life.total_kills_ext : frac(life.sniper_kill_rate));
    const entryRate = p.entry_rate ?? frac(life.entry_rate);
    const tradeSuccess = d.leetify?.stats?.trade_kills_success_percentage ?? null;
    const sig = { tradeOpp: p.trade_opp_pr, tradedOpp: p.traded_opp_pr, survival: p.survival, util: p.util_pr, enemiesFlashed: p.blinded_pr,
      kpr: p.kpr, apr: p.apr, adr: p.adr };

    const why = (label, value) => ({ label, value });
    const pct = (v) => `${Math.round(v)}%`, f2 = (v) => v.toFixed(2);
    const known = (label, v, f) => (v == null || Number.isNaN(v) ? [] : [why(label, f(v))]);
    const scores = {
      awper: sniperShare == null ? null : weighted([[lin(sniperShare, 0.08, 0.35), 0.85], [lin(sig.survival, 25, 45), 0.15]]),
      entry: weighted([[lin(entryRate, 0.08, 0.22), 0.45], [lin(sig.tradedOpp, 0.12, 0.32), 0.3], [inv(lin(sig.survival, 20, 45)), 0.25]]),
      support: weighted([[lin(sig.util, 0.9, 2.4), 0.35], [lin(sig.enemiesFlashed, 0.2, 0.9), 0.25], [lin(sig.apr, 0.08, 0.22), 0.2], [inv(lin(sig.kpr, 0.55, 0.95)), 0.2]]),
      lurker: weighted([[inv(lin(sig.tradeOpp, 0.2, 0.5)), 0.4], [inv(lin(sig.tradedOpp, 0.1, 0.32)), 0.3], [lin(sig.survival, 25, 45), 0.3], [inv(lin(entryRate, 0.08, 0.22)), 0.3]]),
      rifler: weighted([[lin(sig.tradeOpp, 0.22, 0.5), 0.5], [lin(tradeSuccess, 40, 65), 0.3], [lin(sig.kpr, 0.6, 0.95), 0.2], [lin(sig.adr, 70, 95), 0.3]]),
    };
    const reasons = {
      awper: sniperShare == null ? [why("Sniper kills", "no FACEIT sniper data – sign in / add a FACEIT key")] : [why("Kills with sniper rifles", pct(100 * sniperShare)), ...known("Rounds survived", sig.survival, pct)],
      entry: [...known("Entry attempts per round (FACEIT)", entryRate, f2), ...known("Deaths in tradeable spots per round", sig.tradedOpp, f2), ...known("Rounds survived", sig.survival, pct)],
      support: [...known("Grenades per round", sig.util, f2), ...known("Enemies flashed per round", sig.enemiesFlashed, f2), ...known("Assists per round", sig.apr, f2), ...known("Kills per round", sig.kpr, f2)],
      lurker: [...known("Trade chances per round (low = away from team)", sig.tradeOpp, f2), ...known("Deaths in tradeable spots per round", sig.tradedOpp, f2), ...known("Rounds survived", sig.survival, pct), ...known("Entry attempts per round (low = not first in)", entryRate, f2)],
      rifler: [...known("Trade chances per round", sig.tradeOpp, f2), ...known("Trade kill success", tradeSuccess, pct), ...known("Kills per round", sig.kpr, f2), ...known("ADR", sig.adr, (v) => v.toFixed(1))],
    };
    const ranked = Object.keys(scores).map((k) => ({ id: k, ...ROLE_INFO[k], score: scores[k], why: reasons[k] }))
      .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    const [top, second] = ranked;
    const flexible = top.score == null || top.score < 45;
    const gap = top.score != null && second?.score != null ? top.score - second.score : null;
    const confidence = flexible ? "low" : gap >= 15 ? "clear" : "leaning";

    // traits that sit on top of the role
    const lr = d.leetify?.rating || {}, traits = [];
    const clutch1v1 = p.clutch_1v1 ?? (frac(life.clutch_1v1) != null ? 100 * frac(life.clutch_1v1) : null);
    const entryWin = p.entry_success ?? (frac(life.entry_success) != null ? 100 * frac(life.entry_success) : null);
    if ((lr.clutch != null && lr.clutch >= 2) || (lr.clutch == null && clutch1v1 != null && clutch1v1 >= 60)) traits.push("Clutch player");
    if ((lr.opening != null && lr.opening >= 2) || (lr.opening == null && entryWin != null && entryWin >= 55)) traits.push("Wins opening duels");
    if ((lr.opening != null && lr.opening <= -2) || (lr.opening == null && entryWin != null && entryWin < 42)) traits.push("Loses opening duels");
    if (sig.kpr >= 0.85) traits.push("High fragger");
    if (lr.ct != null && lr.t != null && Math.abs(lr.ct - lr.t) >= 2.5) traits.push(lr.ct > lr.t ? "Stronger on CT" : "Stronger on T");
    if (sniperShare == null) traits.push("AWP use unknown (no FACEIT sniper data)");
    if (!d.leetify?.available) traits.push("No Leetify data – trade signals unavailable");

    return {
      available: true, basis, confidence, traits, ranked,
      primary: flexible ? { id: "flex", name: "Flexible rifler", blurb: "No single role stands out – plays a mix of positions." } : top,
      secondary: !flexible && second?.score != null && second.score >= 45 && gap < 20 ? second : null,
    };
  }

  return { integrity, mapCoaching, coachingPlan, role, faceitRating, setPool,
    getPool: () => [...ACTIVE_DUTY], DEFAULT_POOL, KNOWN_MAPS };
})();
