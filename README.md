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

## Tech
- `@supabase/supabase-js` v2 (auth + Postgres + realtime)
- Chart.js for the bar chart
- No build step, no framework
