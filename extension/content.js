/* CS2 Tracker for FACEIT – runs on faceit.com.
 * In a match room it loads all 10 players, adds a small score badge next to each nickname, shows a
 * hover card per player, and a side panel with both line-ups and a map veto comparison.
 * The data work happens in the extension (offscreen.js); this file only reads the page and draws UI,
 * inside a shadow root so FACEIT's styles and ours never mix. */
(() => {
  "use strict";
  if (window.__cs2tracker) return;
  window.__cs2tracker = true;

  const ROOM_RE = /\/room\/(1-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtInt = (v) => (v == null ? "–" : Math.round(v).toLocaleString());
  const signed = (v, d = 2) => (v == null ? "–" : (v > 0 ? "+" : "") + Number(v).toFixed(d));
  const ask = (msg) => new Promise((res) => {
    try { chrome.runtime.sendMessage({ ...msg, target: "bg" }, (r) => res(chrome.runtime.lastError ? { error: chrome.runtime.lastError.message } : r || { error: "no reply" })); }
    catch (e) { res({ error: String(e?.message || e) }); } // extension reloaded: this page needs a refresh
  });

  /* ---------------------------------------------------------------- state --- */
  let me = "", collapsed = false;
  chrome.storage.local.get(["me", "collapsed"]).then((v) => { me = (v.me || "").trim().toLowerCase(); collapsed = !!v.collapsed; renderPanel(); });
  chrome.storage.onChanged.addListener((ch) => { if (ch.me) { me = (ch.me.newValue || "").trim().toLowerCase(); renderPanel(); } });

  let room = null;          // { id, teams, pool, picked }
  let roomError = null;
  const cards = new Map();   // nickname -> card | { error }
  const byNick = new Map();  // nickname -> { side: "faction1" | "faction2", p }
  const teams = {};          // side -> team analysis
  const invs = new Map();    // steam64 -> inventory | "loading"

  const mySide = () => { for (const [nick, x] of byNick) if (nick.toLowerCase() === me) return x.side; return null; };
  const relation = (nick) => { const s = mySide(), x = byNick.get(nick); return !s || !x ? null : x.side === s ? "mate" : "opp"; };

  /* ------------------------------------------------------------------- UI --- */
  const host = document.createElement("div");
  host.id = "cs2t-host";
  host.style.cssText = "position:fixed;inset:0 auto auto 0;z-index:2147483646;width:0;height:0;";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>${CSS()}</style><div class="panel" hidden></div><div class="card" hidden></div>`;
  const panel = root.querySelector(".panel"), cardEl = root.querySelector(".card");
  const mount = () => { if (!host.isConnected) document.documentElement.appendChild(host); };

  /* ------------------------------------------------------------ the room --- */
  async function openRoom(id) {
    room = { id }; roomError = null; cards.clear(); byNick.clear(); invs.clear();
    for (const k of Object.keys(teams)) delete teams[k];
    mount(); renderPanel();
    const r = await ask({ type: "room", matchId: id });
    if (room?.id !== id) return;
    if (r.error) { roomError = r.error; renderPanel(); return; }
    room = r;
    for (const side of ["faction1", "faction2"]) for (const p of r.teams[side].players) byNick.set(p.nick, { side, p });
    renderPanel(); scan();
    const sides = { faction1: [], faction2: [] };
    await Promise.all([...byNick].map(async ([nick, { side, p }]) => {
      const q = p.steam64 || nick;
      const c = await ask({ type: "card", q });
      if (room?.id !== id) return;
      cards.set(nick, c.error ? { error: c.error } : c);
      if (!c.error) sides[side].push(q);
      renderPanel(); scan(); refreshBadges();
    }));
    if (room?.id !== id) return;
    await Promise.all(["faction1", "faction2"].map(async (side) => {
      if (!sides[side].length) return;
      const t = await ask({ type: "team", ids: sides[side], pool: room.pool });
      if (room?.id === id && !t.error) { teams[side] = t; renderPanel(); }
    }));
  }

  function closeRoom() { room = null; roomError = null; panel.hidden = true; cardEl.hidden = true; }

  let lastPath = "";
  setInterval(() => {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    const m = lastPath.match(ROOM_RE);
    if (m && m[1] !== room?.id) openRoom(m[1]);
    else if (!m && room) closeRoom();
  }, 800);

  /* ------------------------------------------------- nicknames in the page --- */
  // FACEIT's markup changes often, so nicknames are found by their text, not by class names.
  function scan() {
    if (!byNick.size || !document.body) return;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (byNick.has(n.nodeValue.trim()) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP) });
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) hits.push(n);
    for (const n of hits) {
      const el = n.parentElement;
      if (!el || el.dataset.cs2t) continue;
      el.dataset.cs2t = n.nodeValue.trim();
      el.addEventListener("mouseenter", () => showCard(el.dataset.cs2t, el));
      el.addEventListener("mouseleave", hideSoon);
      const b = document.createElement("span");
      b.className = "cs2t-badge";
      b.style.cssText = "display:inline-block;margin-left:6px;padding:0 5px;border-radius:6px;font:700 11px/16px system-ui,sans-serif;vertical-align:middle;background:#2a2a28;color:#ddd;white-space:nowrap;";
      b.dataset.cs2tBadge = el.dataset.cs2t;
      el.after(b);
    }
    refreshBadges();
  }
  function refreshBadges() {
    for (const b of document.querySelectorAll("span[data-cs2t-badge]")) {
      const c = cards.get(b.dataset.cs2tBadge);
      const ok = c && !c.error && c.score != null;
      const text = !ok ? (c?.error ? "?" : "…") : `${c.score}${c.form?.tone === "hot" ? " 🔥" : ""}${c.integrity ? " ⚠" : ""}`;
      if (b.textContent === text) continue; // only touch changed badges: every change re-triggers the observer
      b.textContent = text;
      if (!ok) continue;
      b.style.background = toneBg(c.tier?.tone);
      b.style.color = "#fff";
      b.title = `CS2 Tracker: ${c.score} – ${c.tier?.name || ""}`;
    }
  }
  let scanT;
  new MutationObserver(() => { if (!byNick.size) return; clearTimeout(scanT); scanT = setTimeout(scan, 350); })
    .observe(document.documentElement, { childList: true, subtree: true });

  /* ------------------------------------------------------------ hover card --- */
  let hideT, shownNick = null;
  function showCard(nick, anchor) {
    clearTimeout(hideT);
    const c = cards.get(nick);
    shownNick = nick;
    cardEl.innerHTML = !c ? `<div class="muted pad">Loading ${esc(nick)}…</div>`
      : c.error ? `<div class="pad"><b>${esc(nick)}</b><div class="muted">Couldn't load: ${esc(c.error)}</div></div>` : cardHtml(c, relation(nick));
    cardEl.hidden = false;
    place(anchor.getBoundingClientRect());
    if (c && !c.error && c.steam64 && !invs.has(c.steam64)) loadInv(c.steam64, nick, anchor);
  }
  function place(r) {
    const w = cardEl.offsetWidth, h = cardEl.offsetHeight, vw = innerWidth, vh = innerHeight;
    let x = r.right + 12; if (x + w > vw - 8) x = Math.max(8, r.left - w - 12);
    let y = Math.min(Math.max(8, r.top - 20), vh - h - 8);
    cardEl.style.left = `${x}px`; cardEl.style.top = `${Math.max(8, y)}px`;
  }
  const hideSoon = () => { clearTimeout(hideT); hideT = setTimeout(() => { cardEl.hidden = true; shownNick = null; }, 180); };
  cardEl.addEventListener("mouseenter", () => clearTimeout(hideT));
  cardEl.addEventListener("mouseleave", hideSoon);

  async function loadInv(steam64, nick, anchor) {
    invs.set(steam64, "loading");
    const v = await ask({ type: "inventory", steam64 });
    invs.set(steam64, v);
    if (shownNick === nick && !cardEl.hidden) { const c = cards.get(nick); cardEl.innerHTML = cardHtml(c, relation(nick)); place(anchor.getBoundingClientRect()); }
  }

  function cardHtml(c, rel) {
    const edge = c.edge?.color || "#555";
    const ranks = [c.level ? `Lvl ${c.level}` : null, c.elo ? `${fmtInt(c.elo)} ELO` : null, c.premier ? `Premier ${fmtInt(c.premier)}` : null, c.leetify != null ? `Leetify ${signed(c.leetify, 2)}` : null].filter(Boolean).join(" · ");
    const chips = (xs, cls) => xs.map((x) => {
      const lvl = cls === "good" ? (x.v >= 90 ? " exc" : x.v >= 80 ? " elite" : "") : x.v <= 20 ? " severe" : "";
      return `<span class="chip ${cls}${lvl}" title="${esc(x.raw)}">${lvl === " exc" || lvl === " elite" ? "★ " : ""}${esc(x.label)} <small>${esc(x.raw)}</small></span>`;
    }).join("");
    const a = c.aggression;
    const inv = invs.get(c.steam64);
    const invHtml = !inv || inv === "loading" ? `<span class="muted">checking…</span>`
      : inv.status === "private" ? `<span class="muted">Private</span>`
      : inv.status !== "ok" ? `<span class="muted">Couldn't load</span>`
      : inv.total == null ? `${fmtInt(inv.count)} items`
      : `<span class="chip ${inv.rich ? "gold" : ""}">≈ ${esc(inv.total)} <small>${fmtInt(inv.count)} items</small></span>${inv.top?.length ? `<div class="muted small top">${inv.top.slice(0, 3).map((x) => `${esc(x.name)}${x.count > 1 ? ` ×${x.count}` : ""} – ${esc(x.price)}`).join("<br>")}</div>` : ""}`;
    const s = c.stats || {};
    return `<div class="c edge-${c.edge?.tier || "low"}" style="--edge:${edge}">
      <div class="head">
        ${c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : `<div class="av">${esc((c.name || "?")[0].toUpperCase())}</div>`}
        <div class="who"><b>${esc(c.name)}</b>${c.country ? ` <span class="muted">${esc(c.country.toUpperCase())}</span>` : ""}${rel ? ` <span class="rel ${rel}">${rel === "mate" ? "Teammate" : "Opponent"}</span>` : ""}
          <div class="muted small">${esc(ranks)}</div></div>
        ${c.score != null ? `<div class="score ${c.tier?.tone || ""}"><b>${c.score}</b><small>${esc(c.tier?.name || "")}</small></div>` : ""}
      </div>
      ${c.integrity ? `<div class="warn">⚠ ${esc(c.integrity.verdict)}</div>` : ""}
      ${c.role ? `<div class="line"><span class="role">${esc(c.role.name)}</span>${c.role.secondary ? ` <span class="muted">also ${esc(c.role.secondary)}</span>` : ""}</div>` : ""}
      ${a ? `<div class="line meter${a.low ? " low" : ""}"><span class="muted small">Bait</span><span class="track"><span class="dot" style="left:${a.score}%"></span></span><span class="muted small">Aggro</span><b class="${a.tone === "bad" ? "bad" : ""}">${esc(a.label)}</b>${a.low ? ` <span class="muted small">(low confidence)</span>` : ""}</div>` : ""}
      ${c.form ? `<div class="line"><span class="k">Form</span><span class="chip form ${c.form.tone}" title="${esc(c.form.basis)}">${esc(c.form.label)} <small>${esc(c.form.detail)}</small></span></div>` : ""}
      ${c.strengths?.length ? `<div class="line"><span class="k">Strong</span>${chips(c.strengths, "good")}</div>` : ""}
      ${c.weaknesses?.length ? `<div class="line"><span class="k">Weak</span>${chips(c.weaknesses, "bad")}</div>` : ""}
      ${(c.tags || []).map((t) => `<div class="tag ${t.tone}"><b>${esc(t.name)}</b>${rel && t[rel] ? `<div class="small">${esc(t[rel])}</div>` : ""}</div>`).join("")}
      <div class="line small muted">${[s.kd != null ? `K/D ${s.kd.toFixed(2)}` : null, s.adr != null ? `ADR ${Math.round(s.adr)}` : null, s.winrate != null ? `${Math.round(s.winrate)}% wins` : null, s.lifetime ? `${fmtInt(s.lifetime)} matches` : null].filter(Boolean).join(" · ")}</div>
      <div class="line"><span class="k">Inventory</span>${invHtml}</div>
      ${c.missing?.length ? `<div class="muted small">No ${esc(c.missing.join(" or "))} data for this player.</div>` : ""}
      <a class="full" href="${esc(c.url)}" target="_blank" rel="noopener">Full report ↗</a>
    </div>`;
  }

  /* ----------------------------------------------------------------- panel --- */
  function renderPanel() {
    if (!room) { panel.hidden = true; return; }
    mount();
    panel.hidden = false;
    if (collapsed) { panel.className = "panel mini"; panel.innerHTML = `<button class="open" title="CS2 Tracker">CS2T</button>`; panel.querySelector(".open").onclick = () => toggle(false); return; }
    panel.className = "panel";
    const head = `<div class="ph"><b>CS2 Tracker</b><span class="muted small">${room.teams ? "match room" : "loading…"}</span><button class="x" title="Minimise">–</button></div>`;
    let body = "";
    if (roomError) body = roomError === "nokey"
      ? `<div class="pad">Add your FACEIT key (or sign in with your site password) in the extension settings.<br><button class="btn" data-act="options">Open settings</button></div>`
      : `<div class="pad warn">Couldn't load the match: ${esc(roomError)}</div>`;
    else if (!room.teams) body = `<div class="pad muted">Loading the match…</div>`;
    else body = vetoHtml() + ["faction1", "faction2"].map(sideHtml).join("") + (me ? "" : `<div class="pad muted small">Tip: set your FACEIT nickname in the extension settings to see “us vs them” and ban suggestions.</div>`);
    panel.innerHTML = head + `<div class="pb">${body}</div>`;
    panel.querySelector(".x").onclick = () => toggle(true);
    panel.querySelector('[data-act="options"]')?.addEventListener("click", () => ask({ type: "options" }));
    for (const row of panel.querySelectorAll("[data-nick]")) {
      row.addEventListener("mouseenter", () => showCard(row.dataset.nick, row));
      row.addEventListener("mouseleave", hideSoon);
    }
  }
  function toggle(v) { collapsed = v; chrome.storage.local.set({ collapsed: v }); renderPanel(); }

  function sideHtml(side) {
    const t = room.teams[side], mine = mySide();
    const label = mine ? (side === mine ? "Your team" : "Opponents") : t.name || side;
    const ins = teams[side]?.insights;
    const notes = ins ? [...ins.weaknesses, ...ins.strengths].filter((x) => !/^Suggested picks|^Little experience/.test(x.title)).slice(0, 4) : [];
    return `<div class="side"><div class="sh">${esc(label)}${mine ? ` <span class="muted small">${esc(t.name)}</span>` : ""}</div>
      ${t.players.map((p) => {
        const c = cards.get(p.nick);
        const lvl = c?.level ?? p.level;
        if (!c) return `<div class="pr" data-nick="${esc(p.nick)}"><span class="lv">${lvl ?? ""}</span><span class="nm">${esc(p.nick)}</span><span class="muted small">loading…</span></div>`;
        if (c.error) return `<div class="pr" data-nick="${esc(p.nick)}"><span class="lv">${lvl ?? ""}</span><span class="nm">${esc(p.nick)}</span><span class="muted small">no data</span></div>`;
        return `<div class="pr" data-nick="${esc(p.nick)}">
          <span class="lv" style="border-color:${esc(c.edge?.color || "#555")}">${lvl ?? ""}</span>
          <span class="nm">${esc(p.nick)}${c.integrity ? " ⚠" : ""}</span>
          <span class="rl muted small">${esc(c.role?.name || "")}${c.aggression ? ` · ${esc(c.aggression.label)}` : ""}</span>
          <span class="fm">${c.form?.tone === "hot" ? "🔥" : c.form?.tone === "poor" ? `<span class="bad">▼</span>` : c.form?.tone === "good" ? `<span class="good">▲</span>` : ""}</span>
          <span class="sc ${c.tier?.tone || ""}">${c.score ?? "–"}</span>
        </div>`;
      }).join("")}
      ${notes.length ? `<div class="notes">${notes.map((n) => `<div class="small">• ${esc(n.title)}</div>`).join("")}</div>` : ""}
    </div>`;
  }

  function vetoHtml() {
    const a = teams.faction1, b = teams.faction2;
    if (!a?.maps || !b?.maps) return `<div class="veto pad muted small">Map comparison loads once both line-ups are in…</div>`;
    const mine = mySide(), us = mine || "faction1", them = us === "faction1" ? "faction2" : "faction1";
    const U = teams[us], T = teams[them];
    const rows = U.maps.map((m) => {
      const o = T.maps.find((x) => x.map === m.map) || {};
      return { map: m.map, us: m.score, them: o.score, diff: m.score != null && o.score != null ? m.score - o.score : null, usThin: m.unplayed >= 3, themThin: o.unplayed >= 3 };
    });
    const sorted = rows.filter((r) => r.diff != null).sort((x, y) => x.diff - y.diff);
    const ban = new Set(mine ? sorted.filter((r) => r.diff <= -3).slice(0, 2).map((r) => r.map) : []);
    const keep = new Set(mine ? [...sorted].reverse().filter((r) => r.diff >= 3).slice(0, 2).map((r) => r.map) : []);
    const picked = new Set(room.picked || []);
    const name = (side) => (mine ? (side === mine ? "Us" : "Them") : esc(room.teams[side].name || side).slice(0, 10));
    return `<div class="veto"><div class="sh">Map veto <span class="muted small">win % per map, small samples pulled to 50%</span></div>
      <table><thead><tr><th>Map</th><th>${name(us)}</th><th>${name(them)}</th><th>Δ</th><th></th></tr></thead><tbody>
      ${rows.map((r) => `<tr class="${picked.has(r.map) ? "picked" : ""}"><td>${esc(r.map)}</td>
        <td>${r.us != null ? Math.round(r.us) : "–"}${r.usThin ? `<sup title="3+ players with under 5 games">thin</sup>` : ""}</td>
        <td>${r.them != null ? Math.round(r.them) : "–"}${r.themThin ? `<sup title="3+ players with under 5 games">thin</sup>` : ""}</td>
        <td class="${r.diff > 0 ? "good" : r.diff < 0 ? "bad" : ""}">${r.diff != null ? signed(r.diff, 0) : "–"}</td>
        <td>${picked.has(r.map) ? `<span class="tagx pick">Picked</span>` : ban.has(r.map) ? `<span class="tagx ban">Ban</span>` : keep.has(r.map) ? `<span class="tagx keep">Keep</span>` : ""}</td></tr>`).join("")}
      </tbody></table></div>`;
  }

  /* --------------------------------------------------------------- styling --- */
  function toneBg(tone) { return tone === "up" ? "#1f8f3a" : tone === "down" ? "#b23a3a" : "#5b5b55"; }
  function CSS() {
    return `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .panel, .card { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #eceae4; }
    .muted { color: #9a988f; } .small { font-size: 11px; } .pad { padding: 10px 12px; }
    .good { color: #4cc94c; } .bad { color: #ef7d7d; }
    .panel { position: fixed; right: 12px; top: 76px; width: 340px; max-height: calc(100vh - 96px); display: flex; flex-direction: column;
      background: #161615; border: 1px solid #34342f; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.5); overflow: hidden; }
    .panel.mini { width: auto; border-radius: 999px; }
    .open { all: unset; cursor: pointer; padding: 6px 12px; font-weight: 800; color: #ff7a45; }
    .ph { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid #2e2e2b; }
    .ph b { color: #ff7a45; }
    .x { all: unset; cursor: pointer; margin-left: auto; padding: 0 6px; font-size: 16px; color: #9a988f; }
    .pb { overflow: auto; }
    .btn { all: unset; cursor: pointer; margin-top: 8px; padding: 4px 10px; border-radius: 8px; background: #ff7a45; color: #111; font-weight: 700; }
    .warn { color: #ffb4a8; }
    .side { padding: 6px 0; border-top: 1px solid #2a2a27; }
    .sh { padding: 4px 12px; font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #c3c2b7; }
    .pr { display: grid; grid-template-columns: 26px minmax(0, 1fr) auto 30px; grid-template-rows: auto auto; column-gap: 8px; align-items: center; padding: 4px 12px; cursor: default; }
    .pr:hover { background: #22221f; }
    .pr .lv { grid-row: span 2; width: 24px; height: 24px; border-radius: 50%; border: 2px solid #555; display: grid; place-items: center; font-weight: 800; font-size: 11px; }
    .pr .nm { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pr .rl { grid-column: 2 / 4; grid-row: 2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pr .sc { grid-column: 4; grid-row: 1 / span 2; justify-self: end; font-weight: 800; font-size: 16px; }
    .sc.up { color: #4cc94c; } .sc.down { color: #ef7d7d; }
    .notes { padding: 4px 12px 2px 46px; color: #c3c2b7; }
    .veto table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .veto th { text-align: left; font-weight: 600; color: #9a988f; padding: 2px 6px; }
    .veto th:first-child, .veto td:first-child { padding-left: 12px; }
    .veto td { padding: 3px 6px; border-top: 1px solid #24241f; }
    .veto tr.picked td { background: #1d2a1d; }
    .veto sup { font-size: 9px; color: #9a988f; margin-left: 2px; }
    .tagx { padding: 1px 6px; border-radius: 6px; font-weight: 700; font-size: 11px; }
    .tagx.ban { background: #b23a3a; color: #fff; } .tagx.keep { background: #1f8f3a; color: #fff; } .tagx.pick { background: #3a6db2; color: #fff; }
    .card { position: fixed; width: 360px; background: #161615; border-radius: 12px; box-shadow: 0 12px 34px rgba(0,0,0,.55); }
    .c { border: 1px solid color-mix(in srgb, var(--edge) 40%, #34342f); border-radius: 12px; padding: 12px; }
    .c.edge-high { border: 2px solid var(--edge); }
    .c.edge-top { border: 2px solid var(--edge); box-shadow: 0 0 22px -6px var(--edge); }
    .head { display: flex; gap: 10px; align-items: center; }
    .head img, .head .av { width: 44px; height: 44px; border-radius: 10px; object-fit: cover; background: #2a2a27; display: grid; place-items: center; font-weight: 800; }
    .who { min-width: 0; flex: 1; } .who b { font-size: 15px; }
    .rel { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 6px; vertical-align: middle; }
    .rel.mate { background: #1f3d2a; color: #7fdc9a; } .rel.opp { background: #45201f; color: #ff9d94; }
    .score { text-align: center; } .score b { display: block; font-size: 26px; line-height: 1; }
    .score small { font-size: 10px; font-weight: 700; } .score.up b, .score.up small { color: #4cc94c; } .score.down b, .score.down small { color: #ef7d7d; }
    .line { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 8px; }
    .k { font-size: 10px; text-transform: uppercase; letter-spacing: .05em; color: #9a988f; min-width: 52px; }
    .role { padding: 2px 8px; border-radius: 999px; background: #ff7a45; color: #111; font-weight: 700; font-size: 12px; }
    .meter .track { position: relative; width: 70px; height: 4px; border-radius: 2px; background: linear-gradient(90deg, #3987e5, #d0cfc8 50%, #e34948); }
    .meter .dot { position: absolute; top: 50%; width: 10px; height: 10px; border-radius: 50%; background: #fff; transform: translate(-50%, -50%); box-shadow: 0 0 0 2px #161615; }
    .meter.low .track, .meter.low .dot { opacity: .45; }
    .chip { display: inline-flex; gap: 5px; align-items: baseline; padding: 2px 8px; border-radius: 999px; font-weight: 700; font-size: 12px; background: #232321; border: 1px solid #34342f; }
    .chip small { font-weight: 500; font-size: 10px; color: #9a988f; }
    .chip.good { color: #4cc94c; border-color: #1f5a2a; } .chip.bad { color: #ef7d7d; border-color: #6a2a28; }
    .chip.elite { color: #f5c84a; border-color: #8a6d14; }
    .chip.exc { color: #fff; background: linear-gradient(135deg, #e0a800, #ff8a00); border-color: #ffc400; } .chip.exc small { color: #fff; }
    .chip.severe { color: #fff; background: #b23a3a; border-color: #b23a3a; } .chip.severe small { color: #fff; }
    .chip.form.hot { color: #fff; background: linear-gradient(135deg, #ff6a00, #e8340c); border-color: #ff7a2e; } .chip.form.hot small { color: #fff; }
    .chip.form.good { color: #4cc94c; } .chip.form.poor { color: #ef7d7d; }
    .chip.gold { color: #f5c84a; border-color: #8a6d14; }
    .tag { margin-top: 8px; padding: 6px 8px; border-radius: 8px; background: #1f1f1d; border-left: 3px solid #5b5b55; }
    .tag.bad { border-left-color: #e34948; } .tag.info { border-left-color: #3987e5; }
    .top { margin-top: 4px; width: 100%; }
    .full { display: inline-block; margin-top: 10px; color: #ff7a45; text-decoration: none; font-weight: 700; font-size: 12px; }
    `;
  }
})();
