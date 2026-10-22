/* CS2 Tracker - analysis on top of a player summary (works with both the
 * Python server and the in-browser engine, which return the same JSON).
 *
 *  - Analysis.integrity(d): statistical anomaly indicators. These are NOT proof
 *    of cheating - talented players produce outliers too; only FACEIT/Valve
 *    anti-cheat can establish cheating.
 *  - Analysis.mapCoaching(d): per-map strengths/weaknesses vs the player's own
 *    other maps, turned into concrete tips.
 *
 * Aim data (preaim, reaction time, accuracy) comes from Leetify; FACEIT's API
 * has no aim-level data, and neither API exposes positions/rotations.
 */
"use strict";

const Analysis = (() => {
  const mean = (xs) => { const v = xs.filter((x) => x != null && !Number.isNaN(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
  const ratio = (a, b) => (b ? a / b : null);
  const r1 = (v) => (Math.abs(v) < 0.05 ? 0 : v).toFixed(1); // no "-0.0"

  /* --------------------------------------------------------- integrity --- */
  // Reference: a top professional's Leetify profile (s1mple, observed Oct 2026) averaged
  // ~5.8° preaim, ~417 ms reaction time and ~24% head accuracy. Thresholds sit beyond that.
  const PRO_REF = { preaim: 5.8, reaction: 417, head: 23.8 };
  const T = { preaim: 4.5, reaction: 370, head: 30, matchPreaim: 3.0, matchReaction: 300, extremeShare: 0.25 };

  function integrity(d) {
    const lt = d.leetify || {}, st = lt.stats || {}, items = [];
    const add = (status, label, value, ref, detail) => items.push({ status, label, value, ref, detail });
    if (!lt.available) return { available: false, reason: "Needs Leetify data (aim statistics come from Leetify)." };

    // 1. bans recorded on the player's own accounts
    if ((lt.bans || []).length)
      add("flag", "Platform ban on record", lt.bans.map((b) => b.platform).join(", "), "none", "Leetify lists a ban on one of this player's linked platform accounts.");
    else add("ok", "Platform bans on record", "none", "none");

    // 2-4. lifetime aim averages vs a top-pro reference
    const lifetime = [
      ["Average crosshair placement (preaim)", st.preaim, (v) => `${v.toFixed(1)}°`, (v) => v < T.preaim, `top pro ≈ ${PRO_REF.preaim}°; outlier below ${T.preaim}°`],
      ["Average reaction time", st.reaction_time_ms, (v) => `${Math.round(v)} ms`, (v) => v < T.reaction, `top pro ≈ ${PRO_REF.reaction} ms; outlier below ${T.reaction} ms`],
      ["Head accuracy", st.accuracy_head, (v) => `${v.toFixed(1)}%`, (v) => v > T.head, `top pro ≈ ${PRO_REF.head}%; outlier above ${T.head}%`],
    ];
    for (const [label, v, f, isOut, ref] of lifetime) if (v != null) add(isOut(v) ? "outlier" : "ok", label, f(v), ref);

    // 5. share of individual matches with extreme aim values
    const ms = (d.matches || []).filter((m) => m.aim_preaim != null || m.reaction_ms != null);
    if (ms.length >= 10) {
      const extreme = ms.filter((m) => (m.aim_preaim != null && m.aim_preaim < T.matchPreaim) || (m.reaction_ms != null && m.reaction_ms < T.matchReaction));
      const share = extreme.length / ms.length;
      add(share > T.extremeShare ? "outlier" : extreme.length ? "note" : "ok", "Matches with extreme aim values",
        `${extreme.length} of ${ms.length}`, `preaim < ${T.matchPreaim}° or reaction < ${T.matchReaction} ms; outlier above ${Math.round(T.extremeShare * 100)}% of matches`,
        extreme.length ? `Maps: ${[...new Set(extreme.map((m) => m.map))].join(", ")}` : null);
    }

    // 6. sudden improvement: recent matches vs older ones (chronological order is newest first)
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

    // 7. mechanical skill out of line with rank
    const aim = lt.rating?.aim, premier = lt.ranks?.premier, level = d.faceit?.available ? d.faceit.level : lt.ranks?.faceit;
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

    const outliers = items.filter((i) => i.status === "outlier").length, flags = items.filter((i) => i.status === "flag").length;
    const notes = items.filter((i) => i.status === "note").length;
    const level_ = flags ? "flag" : outliers >= 2 ? "high" : outliers || notes ? "some" : "none";
    const verdict = {
      none: "No statistical anomalies – everything is within what strong legitimate players produce.",
      some: "A few unusual values. On their own these are common among talented players.",
      high: "Several values beyond a top-pro reference at the same time. Worth a closer look at demos – still not proof.",
      flag: "A platform ban is on record for this player.",
    }[level_];
    return { available: true, level: level_, verdict, items, context, counts: { outliers, notes, flags } };
  }

  /* ------------------------------------------------------- map coaching --- */
  function profile(ms) {
    const ex = ms.filter((m) => m.ext && m.rounds);
    if (!ex.length) return null;
    const e = (k) => ex.map((m) => m.ext[k]);
    const rounds = sum(ex.map((m) => m.rounds));
    const flashes = sum(e("flash_thrown")), heThrown = sum(e("he_thrown"));
    const nades = flashes + heThrown + sum(e("molotov_thrown")) + sum(e("smoke_thrown"));
    const decided = ms.filter((m) => m.outcome === "win" || m.outcome === "loss");
    const k = sum(ms.map((m) => m.kills)), dth = sum(ms.map((m) => m.deaths));
    return {
      n: ms.length,
      winrate: decided.length ? (100 * decided.filter((m) => m.outcome === "win").length) / decided.length : null,
      rating: mean(ms.map((m) => m.rating)), ct: mean(ms.map((m) => m.ct_rating)), t: mean(ms.map((m) => m.t_rating)),
      kd: ratio(k, dth), adr: mean(ms.map((m) => m.adr)),
      util_pr: ratio(nades, rounds),
      // grenade efficiency needs a minimum sample, or a couple of throws decide the tip
      flash_eff: flashes >= 10 ? ratio(sum(e("flash_foe")), flashes) : null,
      flash_team: flashes >= 10 ? ratio(sum(e("flash_friend")), flashes) : null,
      he_dmg: heThrown >= 5 ? ratio(sum(ex.map((m) => (m.ext.he_dmg_avg || 0) * (m.ext.he_thrown || 0))), heThrown) : null,
      util_death: mean(e("util_on_death")),
      trade: ratio(100 * sum(e("trade_succ")), sum(e("trade_opps"))),
      traded: ratio(100 * sum(e("traded_succ")), sum(e("traded_opps"))),
      survival: ratio(100 * sum(e("survived")), rounds),
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

  function mapCoaching(d) {
    const byMap = {};
    for (const m of d.matches || []) (byMap[m.map] ||= []).push(m);
    const maps = Object.keys(byMap).filter((k) => byMap[k].filter((m) => m.ext).length >= MIN_MATCHES);
    if (!maps.length) return { available: false, reason: `Needs at least ${MIN_MATCHES} Leetify-analysed matches on a map.` };
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
        if (p.winrate != null && others.winrate != null && p.winrate < others.winrate - 12 && p.rating != null && others.rating != null && p.rating >= others.rating)
          tips.push({ key: "team", gap: 0.05, text: `You lose more on ${name} (${Math.round(p.winrate)}% win rate vs ${Math.round(others.winrate)}%) even though your own rating holds up – the issue is more likely team strategy on ${name} than your individual play.` });
      }
      tips.sort((a, b) => b.gap - a.gap);
      return { map: name, stats: p, others, tips: tips.slice(0, 4), strengths };
    });
    // weakest map first: most tips, then lowest rating
    result.sort((a, b) => b.tips.length - a.tips.length || (a.stats?.rating ?? 0) - (b.stats?.rating ?? 0));
    const skipped = Object.keys(byMap).filter((k) => !maps.includes(k));
    return { available: true, maps: result, minMatches: MIN_MATCHES, skipped };
  }

  return { integrity, mapCoaching };
})();
