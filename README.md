# Salad Stories — Orders

Team app for subscriptions, bills, kitchen prep and delivery lists.

- `public/index.html` — the app (one page)
- `netlify/functions/api.mts` — API at `/api/*`, stores data in Neon Postgres (`docs` table)

Netlify environment variables needed (Functions scope):
- `DATABASE_URL` — Neon connection string
- `TEAM_PIN` — the PIN the team types to open the app
