# CS2 Tracker

A local web app that combines **FACEIT** and **Leetify** data into one statistical summary of a Counter-Strike 2 player, and tracks their progress over time.

## Run locally

Needs Python 3.9+. No packages to install.

```
python server.py
```

Open http://127.0.0.1:8765, or double-click `start.bat` on Windows. Click **Demo** to see the app with synthetic data.

## Put it online

There are two ways to host it:

| | GitHub Pages (simplest) | Render |
|---|---|---|
| Cost / accounts | Free, nothing extra | Free, needs a Render account |
| Always on | Yes | Sleeps after 15 min idle, first load ~30–60 s |
| Password | No, anyone with the link can open it | Yes |
| API keys | Each browser stores its own, entered in ⚙ Settings | Server environment |
| Progress history | Stored per browser, with export/import to move it | Shared, saved to the `data` branch |
| Steam `/id/name` URLs | Not supported. Use Steam64 or FACEIT nickname | Supported |

### GitHub Pages

The same `static/` app detects when there's no Python server and runs fully in the browser. It calls FACEIT and Leetify directly; both allow this.

1. The repo must be **public**, since Pages on a free GitHub plan only works for public repos.
2. In the repo, go to **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Push to `main`, or run the *Deploy to GitHub Pages* workflow. The site is published at `https://<user>.github.io/cs2-tracker/`.
4. On the site, open ⚙ Settings and paste a FACEIT **Client side** key, from App Studio → API keys. In App Studio you can restrict that key to your `github.io` domain.

## Put it online (Render, free)

This gives you a password-protected URL you can open from home or your phone. It takes about 10 minutes, all of it in your browser.

1. **Create a GitHub token** so the site can save progress history to this repo's `data` branch.
   On GitHub, go to Settings → Developer settings → Fine-grained tokens → *Generate new token*. Set:
   - Repository access: *Only select repositories* → `cs2-tracker`
   - Permissions: **Contents → Read and write** (nothing else)
   - Pick an expiration date, and remember to renew the token before it expires.
2. **Get a FACEIT API key** at developers.faceit.com → App Studio → API keys → *Server side*.
3. **Deploy:** sign up at render.com with GitHub, then go to **New + → Blueprint** and select the `cs2-tracker` repo. Give Render access to this repo when it asks. Render reads `render.yaml` and asks for:
   - `APP_PASSWORD`: the password you'll type to open the site. Any username works.
   - `FACEIT_API_KEY`
   - `LEETIFY_API_KEY`: optional, so you can leave it empty
   - `GITHUB_TOKEN`: the token from step 1
4. Click **Apply**. When the deploy finishes, open the `https://cs2-tracker-xxxx.onrender.com` URL Render shows you.

Notes:
- On the free plan the server sleeps after 15 minutes without visits, so the first page load after that takes about 30–60 seconds.
- Progress history is committed to the `data` branch, so it survives restarts and redeploys. Pushing to `main` redeploys the site automatically.
- To change a key or the password, go to Render dashboard → service → Environment. The in-app Settings dialog is read-only when the app is hosted.

## Searching for a player

You can search with any of these:
- A Steam64 ID (`7656119…`)
- A Steam profile URL (`steamcommunity.com/profiles/…` or `/id/<vanity>`)
- A FACEIT nickname or FACEIT profile URL (this needs a FACEIT key)

## API keys (⚙ Settings)

| Source | Needed? | Where to get it |
|---|---|---|
| FACEIT Data API | Required for FACEIT data | developers.faceit.com → App Studio → API keys → *Server side* |
| Leetify Public API | Optional. Without a key, requests are rate-limited more heavily | leetify.com/app/developer |

Keys are saved only in `data/config.json`. You can also set them with the `FACEIT_API_KEY` and `LEETIFY_API_KEY` environment variables.

## What's in the summary

- **Ranks:** FACEIT level and ELO, Premier, Leetify rating, Wingman, competitive rank per map, and Renown
- **Performance score (0–100):** a weighted composite of Leetify aim, positioning and utility, plus K/D, ADR, Leetify rating and win rate. 50 is roughly average.
- **Last 100 matches across all platforms:** win rate, K/D, ADR, HS%, KPR, Leetify rating and 3K+ rounds. Each is compared between the last 10 matches and earlier ones, alongside win and loss streaks.
- **Strengths and areas to improve:** stats compared against rule-of-thumb reference values (these are not official benchmarks)
- **Progress:** a snapshot is saved to `data/snapshots/<steam64>.json` each time you look a player up (at most one every 10 minutes). Charts show ELO, Premier, Leetify rating, aim/positioning/utility, K/D and ADR over time, plus Premier rating per match.
- **Match-by-match form:** Leetify rating, K/D, ADR or HS% per match, with a 5-match rolling average
- **Leetify skill profile:** sub-ratings, mechanics (reaction time, preaim, accuracy, spray, counter-strafing), utility, trading and opening duels
- **FACEIT lifetime stats:** including entry success rate, 1vX clutch win rates, flash success and utility damage
- **Map pool:** recent stats per map next to FACEIT lifetime stats per map
- **By platform:** FACEIT, Premier, competitive, and others
- **Match history:** a filterable list of matches

The tracker builds up history only when you look a player up. To log progress automatically, call `http://127.0.0.1:8765/api/player?q=<steam64>` on a schedule, for example with Windows Task Scheduler.
