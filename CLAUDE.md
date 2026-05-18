# Time Tracker

Two-person time tracking web app. Static site (HTML/CSS/JS) + Supabase backend.

## Stack
- Vanilla JS (no framework, no build step)
- Supabase JS v2 (auth + Postgres + realtime)
- Chart.js for bar charts
- Hosted on GitHub Pages: https://github.com/BrendanTipney/Time-tracker

## Local dev
Open `index.html` via a local server (e.g. `python -m http.server 5500`).
Config lives in `config.js` (gitignored) — copy from `config.example.js` and fill in Supabase credentials.

## Files
- `index.html` — single-page UI
- `styles.css` — dark minimal teal theme
- `app.js` — all client logic (auth, timer, entries, calendar, chart, export)
- `config.js` — Supabase URL + anon key (gitignored, not committed)
- `config.example.js` — template (has real creds committed for GitHub Pages deploy)
- `supabase-setup.sql` — initial schema + RLS policies
- `migration_projects.sql` — adds projects table
- `favicon.svg` — teal minimal clock icon
- `apple-touch-icon.png` — 180x180 PNG for iOS PWA
- `manifest.json` — PWA manifest

## Database (Supabase)
Tables: `profiles`, `time_entries`, `projects`
- All authenticated users can read all rows (both partners share data)
- Users can only insert/update/delete their own rows
- Realtime enabled on all three tables

## Code style
- Vanilla JS wrapped in an IIFE
- `const $ = (id) => document.getElementById(id)` for DOM access
- State lives in a single `state` object
- No TypeScript, no bundler
