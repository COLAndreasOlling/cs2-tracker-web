"use strict";
/* Settings: FACEIT access and the user's own nickname.
 * The key is kept by the tracker engine in the extension's own storage, which the offscreen page
 * shares (same extension origin) – so signing in here is all the match room needs. */

const SITE = "https://colandreasolling.github.io/cs2-tracker-web/";
const $ = (id) => document.getElementById(id);
const say = (el, text, ok) => { el.textContent = text; el.className = `status ${ok ? "ok" : "err"}`; };

/** Load the engine with the site's config (its password-locked key), the same way the site does. */
const engineReady = (async () => {
  let cfg = { faceitApiKey: "", faceitKeyLocked: "" };
  try {
    const text = await (await fetch(`${SITE}config.js`, { cache: "no-store" })).text();
    const m = text.match(/=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (m) cfg = { ...cfg, ...JSON.parse(m[1]) };
  } catch { /* offline: pasting a key still works */ }
  window.CS2_CONFIG = { faceitApiKey: "", faceitKeyLocked: cfg.faceitKeyLocked || "" };
  await new Promise((res, rej) => { const s = document.createElement("script"); s.src = "lib/engine.js"; s.onload = res; s.onerror = rej; document.head.appendChild(s); });
})();

async function refresh() {
  await engineReady;
  const c = await Engine.handle("/api/config");
  const el = $("keyStatus");
  if (c.signed_in) say(el, "✓ Signed in – using the site's FACEIT key.", true);
  else if (c.faceit_own) say(el, "✓ Using your own FACEIT key.", true);
  else say(el, "Not set up yet – sign in or paste a key below.", false);
}

$("unlock").onclick = async () => {
  await engineReady;
  try { await Engine.unlock($("pw").value, true); $("pw").value = ""; say($("keyMsg"), "Signed in.", true); }
  catch (e) { say($("keyMsg"), e.message, false); }
  refresh();
};
$("saveKey").onclick = async () => {
  await engineReady;
  const key = $("key").value.trim();
  if (!key) return say($("keyMsg"), "Paste a key first.", false);
  await Engine.handle("/api/config", { method: "POST", body: JSON.stringify({ faceit_api_key: key }) });
  $("key").value = ""; say($("keyMsg"), "Key saved.", true); refresh();
};
$("signOut").onclick = async () => {
  await engineReady;
  Engine.signOut();
  await Engine.handle("/api/config", { method: "POST", body: JSON.stringify({ faceit_api_key: "" }) });
  say($("keyMsg"), "Removed.", true); refresh();
};

chrome.storage.local.get("me").then((v) => { $("me").value = v.me || ""; });
$("saveMe").onclick = async () => {
  await chrome.storage.local.set({ me: $("me").value.trim() });
  say($("meMsg"), "Saved. Open (or reload) a match room to use it.", true);
};

refresh();
