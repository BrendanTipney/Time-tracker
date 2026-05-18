# Time Tracker

Minimal two-person time tracker. Static site (HTML/CSS/JS) + Supabase (auth + Postgres). Hostable on GitHub Pages.

## Setup

### 1. Supabase project
1. Create a project at [supabase.com](https://supabase.com).
2. Go to **SQL Editor → New Query**, paste the contents of `supabase-setup.sql`, click **Run**.
3. Go to **Settings → API**, copy the **Project URL** and **anon/public key**.

### 2. Local config
Copy `config.example.js` to `config.js` and fill in the URL and anon key. `config.js` is gitignored.

```bash
cp config.example.js config.js
# edit config.js
```

### 3. Sign up both accounts
Open `index.html` locally (or after deploy) and sign up you + your partner. Once you're both in, go to Supabase **Authentication → Providers → Email** and turn off **Enable Signups** to lock the door.

### 4. Deploy to GitHub Pages
1. Commit `config.js` locally only (it's gitignored) — the site needs it at runtime, so either:
   - **Option A (simpler, acceptable for anon key):** Remove `config.js` from `.gitignore` and commit it. The Supabase anon key is safe to expose publicly *as long as RLS policies are on* (the setup SQL enables them).
   - **Option B:** Keep it gitignored and host via a branch where you manually add it before deploy.
2. Push to GitHub.
3. In the repo: **Settings → Pages → Source = Deploy from branch**, branch `main`, folder `/ (root)`.
4. Visit `https://<you>.github.io/Time-tracker/`.

## Features
- Start/stop timer with optional task label
- Realtime sync between you and your partner
- Edit or delete any past entry you own
- Today / Calendar / Chart / Export tabs
- CSV export filtered by date range and user

## Desktop app (Electron, with system tray)

The same web client also runs as a desktop app with a system-tray icon that shows the running timer and lets you start/stop without opening the window.

```bash
npm install      # one-time
npm start        # run the desktop app

npm run build:win    # build a Windows installer (.exe via NSIS, output to dist/)
npm run build:mac    # build a macOS .dmg
npm run build:linux  # build a Linux AppImage
```

Tray behaviour:
- Closing the window hides it; the app stays running in the tray.
- Right-click tray → **Start/Stop timer**, **Open**, or **Quit**.
- macOS shows the running elapsed time directly in the menu bar.
- Windows shows the elapsed time in the tray icon's tooltip.

Both desktop and web read from `config.js` and sync via Supabase, so installing the desktop app on your machine and your partner using the web version (or vice-versa) works without further setup.

## Tech
- `@supabase/supabase-js` v2 (auth + Postgres + realtime)
- Chart.js for the bar chart
- No build step, no framework
