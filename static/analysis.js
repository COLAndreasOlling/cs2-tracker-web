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
    const add = (status, label, value, ref, detail, matches) => items.push({ status, label, value, ref, detail, matches });
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
        null, extreme.map((m) => ({ ...m, extremePreaim: m.aim_preaim != null && m.aim_preaim < T.matchPreaim,
          extremeReaction: m.reaction_ms != null && m.reaction_ms < T.matchReaction })));
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

  /* ------------------------------------------------------ coaching plan --- */
  // Areas of the game, each with checks against rough rule-of-thumb references (not official
  // benchmarks) and the map-coaching tip keys that point to the same problem. A problem that
  // shows up on several maps raises the area's priority.
  const clampSev = (x) => Math.max(0.2, Math.min(2, x));
  const AREAS = [
    { id: "aim", title: "Aim mechanics", mapKeys: ["preaim"], checks: [
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
    ] },
    { id: "utility", title: "Utility usage", mapKeys: ["util_pr", "flash_eff", "flash_team", "util_death", "he_dmg"], checks: [
      { label: "Utility rating", get: (c) => c.lt.rating?.utility, weak: (v) => v < 45, good: (v) => v >= 65, fmt: (v) => v.toFixed(0), ref: "≥ 65 good · < 45 weak (Leetify)", sev: (v) => (45 - v) / 15,
        action: "Learn 2 smokes, 1 molotov and 1 pop-flash for each bombsite on your 3 most-played maps." },
      { label: "Grenades thrown per round", get: (c) => c.p?.util_pr, weak: (v) => v < 1.0, good: (v) => v >= 1.5, fmt: (v) => v.toFixed(2), ref: "≥ 1.5 good · < 1.0 weak", sev: (v) => (1.0 - v) / 0.4,
        action: "Buy and use a full utility set when you can afford it – every round should start with a plan for your grenades." },
      { label: "Enemies blinded per flash", get: (c) => c.st.flashbang_hit_foe_per_flashbang, weak: (v) => v < 0.4, good: (v) => v >= 0.6, fmt: (v) => v.toFixed(2), ref: "≥ 0.6 good · < 0.4 weak", sev: (v) => (0.4 - v) / 0.2,
        action: "Throw pop-flashes that burst as they cross the angle, not behind walls – practise 2 per site in a private server." },
      { label: "Teammates blinded per flash", get: (c) => c.st.flashbang_hit_friend_per_flashbang, weak: (v) => v >= 0.6, good: (v) => v <= 0.3, fmt: (v) => v.toFixed(2), ref: "≤ 0.3 good · ≥ 0.6 weak", sev: (v) => (v - 0.6) / 0.3,
        action: "Call every flash (\"flashing A main\") and throw over your teammates, not past them." },
      { label: "Unused utility at death", get: (c) => c.st.utility_on_death_avg, weak: (v) => v >= 300, good: (v) => v <= 150, fmt: (v) => `$${Math.round(v)}`, ref: "≤ $150 good · ≥ $300 weak", sev: (v) => (v - 300) / 200,
        action: "Use your grenades before you take a fight you might lose – a molotov on a push or a flash for your own peek." },
    ] },
    { id: "teamplay", title: "Trading & teamplay", mapKeys: ["trade", "traded"], checks: [
      { label: "Trade kill success", get: (c) => c.st.trade_kills_success_percentage, weak: (v) => v < 40, good: (v) => v >= 55, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 55% good · < 40% weak", sev: (v) => (40 - v) / 15,
        action: "When your entry player goes in, be ready to re-peek within 1–2 seconds – stay one step behind them, not across the map." },
      { label: "Deaths that get traded", get: (c) => c.st.traded_deaths_success_percentage, weak: (v) => v < 30, good: (v) => v >= 45, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 45% good · < 30% weak", sev: (v) => (30 - v) / 15,
        action: "Take fights where a teammate can swing for you; tell the team before you peek so someone is ready to trade." },
    ] },
    { id: "positioning", title: "Positioning & opening duels", mapKeys: ["survival"], checks: [
      { label: "Positioning rating", get: (c) => c.lt.rating?.positioning, weak: (v) => v < 45, good: (v) => v >= 65, fmt: (v) => v.toFixed(0), ref: "≥ 65 good · < 45 weak (Leetify)", sev: (v) => (45 - v) / 15,
        action: "After first contact, reposition instead of re-peeking the same angle; avoid spots with no escape route." },
      { label: "Rounds survived", get: (c) => c.p?.survival, weak: (v) => v < 25, good: (v) => v >= 35, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 35% good · < 25% weak", sev: (v) => (25 - v) / 10,
        action: "Play for information early in the round – fall back after contact more often instead of forcing the duel." },
      { label: "Opening duels won on CT", get: (c) => c.st.ct_opening_duel_success_percentage, weak: (v) => v < 45, good: (v) => v >= 55, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 55% good · < 45% weak", sev: (v) => (45 - v) / 10,
        action: "On CT, hold off-angles and use a crossfire with a teammate instead of taking the first duel alone." },
      { label: "Opening duels won on T", get: (c) => c.st.t_opening_duel_success_percentage, weak: (v) => v < 45, good: (v) => v >= 55, fmt: (v) => `${Math.round(v)}%`, ref: "≥ 55% good · < 45% weak", sev: (v) => (45 - v) / 10,
        action: "On T, don't dry-peek for the opening kill – take it with a flash, or let your entry player take it and trade." },
    ] },
    { id: "rounds", title: "Clutches & round impact", mapKeys: [], checks: [
      { label: "Clutch rating", get: (c) => c.lt.rating?.clutch, weak: (v) => v < -1, good: (v) => v >= 2, fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1), ref: "≥ +2 good · < −1 weak (Leetify)", sev: (v) => (-1 - v) / 2,
        action: "In clutches, slow down: use the time, isolate one duel at a time, and play the bomb/sound instead of rushing peeks." },
      { label: "Opening rating", get: (c) => c.lt.rating?.opening, weak: (v) => v < -1, good: (v) => v >= 2, fmt: (v) => (v > 0 ? "+" : "") + v.toFixed(1), ref: "≥ +2 good · < −1 weak (Leetify)", sev: (v) => (-1 - v) / 2,
        action: "You're losing too many first duels – take opening fights only with utility or a teammate ready to trade." },
    ] },
  ];

  // map-coaching tip keys -> what recurs, and what to do about it
  const PATTERNS = {
    util_pr: ["Grenades used per round", "Plan your utility for each round on these maps – learn the default smokes/molotovs for both sites."],
    flash_eff: ["Enemies blinded per flash", "Practise pop-flashes for the main entrances on these maps in a private server."],
    flash_team: ["Teammates blinded per flash", "Call your flashes and throw them over teammates, not past them – especially on these maps."],
    util_death: ["Unused utility when dying", "Use your grenades earlier in the round on these maps instead of dying with them."],
    he_dmg: ["HE damage per grenade", "Learn the common stacking spots on these maps and throw HEs there, ideally together with a teammate."],
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
    const c = { lt: lt.available ? lt : {}, st: (lt.available && lt.stats) || {}, p: profile(d.matches || []) };
    const mapsWith = (keys) => (coach?.available ? coach.maps.filter((m) => m.tips.some((t) => keys.includes(t.key))).map((m) => m.map) : []);
    const areas = [], keep = [];

    for (const a of AREAS) {
      const evidence = [], actions = [];
      let sev = 0;
      for (const ch of a.checks) {
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

    // side balance across all maps
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

    // mental & consistency
    const tl = tilt(d.matches || []);
    const rated = (d.matches || []).filter((m) => m.rating != null);
    const badShare = rated.length >= 15 ? rated.filter((m) => m.rating < -3).length / rated.length : null;
    const mental = { evidence: [], actions: [], sev: 0 };
    if (tl && tl.afterWin - tl.afterLoss >= 15) {
      mental.sev += clampSev((tl.afterWin - tl.afterLoss - 15) / 15 + 0.5);
      mental.evidence.push({ label: "Win rate after a loss vs after a win", value: `${Math.round(tl.afterLoss)}% vs ${Math.round(tl.afterWin)}%`, ref: "a 15+ point drop suggests tilt" });
      mental.actions.push("After 2 losses in a row, take a 15-minute break before queuing again.");
    }
    if (badShare != null && badShare > 0.3) {
      mental.sev += clampSev((badShare - 0.3) / 0.15 + 0.3);
      mental.evidence.push({ label: "Matches with a very low Leetify rating (< −3)", value: `${Math.round(badShare * 100)}%`, ref: "over 30% means too many off-games" });
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
    return { priorities, more, keep: keep.slice(0, 6), routine, matches: (d.matches || []).length };
  }

  return { integrity, mapCoaching, coachingPlan };
})();
