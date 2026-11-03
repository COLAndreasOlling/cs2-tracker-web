# CS2 Tracker for FACEIT (Chrome extension)

Adds your CS2 Tracker stats to FACEIT match rooms:

- **Score badges** next to every nickname (performance score, 🔥 when on fire, ⚠ on integrity flags).
- **Hover cards** with level/ELO, performance tier, role, bait ↔ aggro meter, form, strong/weak points,
  playstyle tags with advice *as a teammate* or *as an opponent*, key stats and inventory value.
- **Side panel** with both line-ups and a **map veto table**: each side's win rate per map (small samples
  pulled towards 50%), the difference, and Ban / Keep suggestions once your nickname is set.

Everything runs in your browser. Data comes from FACEIT, Leetify, Steam (public inventories) and the
site's daily price list – the same engine and analysis as the website.

## Install (Chrome, Edge, Brave)

1. Download and unzip the extension (or use this `extension` folder).
2. Open `chrome://extensions`, turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. The settings page opens: **sign in with your site password** (or paste a FACEIT API key) and enter
   **your FACEIT nickname**.
5. Open a FACEIT match room. The panel appears on the right; hover any nickname for its card.

## Updating

Replace the folder with the new version and click the ↻ reload icon on the extension in `chrome://extensions`,
then reload the FACEIT tab.

## For development

`lib/engine.js`, `lib/analysis.js` and `lib/insights.js` are copies of the site's files. After changing
those in `static/`, run `python extension/sync_lib.py`.
