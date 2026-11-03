/* Service worker: routes the content script's requests to the offscreen page, where the tracker's
 * engine runs with its own storage (never FACEIT's) and the extension's network permissions. */

let creating = null;
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  creating ||= chrome.offscreen.createDocument({
    url: "offscreen.html", reasons: ["DOM_PARSER"],
    justification: "Runs the CS2 Tracker engine (player stats and analysis) for the FACEIT match room.",
  }).finally(() => { creating = null; });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.target !== "bg") return false;
  if (msg.type === "options") { chrome.runtime.openOptionsPage(); reply({ ok: true }); return false; }
  (async () => {
    try {
      await ensureOffscreen();
      reply(await chrome.runtime.sendMessage({ ...msg, target: "offscreen" }));
    } catch (e) { reply({ error: String(e?.message || e) }); }
  })();
  return true; // async reply
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener((d) => { if (d.reason === "install") chrome.runtime.openOptionsPage(); });
