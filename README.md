# Edge URL Shortener and Analytics

Shorten links with custom slugs, QR codes, and click analytics by country and device. Runs on Cloudflare Workers and D1. Live at https://go.avenash-kumar.com

No signup is needed to use the live site. The code is open for review and for learning how a Worker plus D1 app is built.

## Features

- Create a short link with a custom slug, optional expiry, and optional click limit
- QR code for every short link, generated in the browser
- Redirects at the edge, with click tracking for country, device, browser, and referrer
- Dashboard with total clicks, top links, and 7, 14, and 30 day charts
- Search and filter links, copy, pause and resume, and per link analytics
- Pause, expiry, and click limit checks on every redirect

## Tech

- Cloudflare Workers, TypeScript, and D1 (SQLite at the edge)
- Static frontend in `public/`, no build step for the UI
- GitHub Actions plus Wrangler for deploy on merge to main

## Local setup

```bash
npm install
npx wrangler d1 create edge-url-shortener
# Copy the database_id from the output into wrangler.toml
npx wrangler d1 migrations apply edge-url-shortener --local
npm run dev
```

Open http://localhost:8787

## Deploy

1. Create the D1 database once, in production:
```bash
npx wrangler d1 migrations apply edge-url-shortener --remote
```
2. In Cloudflare, add the custom domain `go.avenash-kumar.com` to the Worker, or use the route in `wrangler.toml`.
3. In GitHub, add these repo secrets:
   - `CLOUDFLARE_API_TOKEN`, a token with Edit Cloudflare Workers permission for this account
   - `CLOUDFLARE_ACCOUNT_ID`, from the Cloudflare dashboard
4. Push to `main`. The workflow in `.github/workflows/deploy.yml` runs `wrangler deploy`.

Do not paste tokens or account IDs in chat. Add them only in GitHub Secrets.

## API

- `POST /api/links` with `{ url, slug, expiresAt, maxClicks }`
- `POST /api/links/lookup` with `{ slugs: [] }`, returns only the requested links. There is no endpoint that lists every link, so no visitor can enumerate other people's links. The frontend stores the slugs you create in your browser's localStorage and looks those up.
- `GET /api/stats` returns only totals: totalLinks, totalClicks, activeLinks
- `GET /api/links/:slug/stats?days=7`
- `PATCH /api/links/:slug` with `{ paused }`
- `DELETE /api/links/:slug`
- `GET /:slug` redirects to the long URL and records a click

## Design

The UI uses an improvised palette inspired by a clean premium style, not a copy of any other brand. Hero: deep midnight #0B1526 to indigo #3730A3. Primary: electric indigo #4F46E5. Accent: teal #2DD4BF. Headings: ink #0F172A. Font: Manrope.

## E2E tests

Playwright tests in `e2e/` run against the live site by default (`https://go.avenash-kumar.com`, override with `E2E_BASE_URL`):

```bash
npm ci
npx playwright install chromium
npm run test:e2e
```

They cover health, homepage and theme toggle, creating, redirecting and deleting a link (the test deletes its own link, so it does not count toward the 100 link limit), invalid URLs, duplicate slugs, and the links list total. The `E2E tests` workflow in `.github/workflows/e2e.yml` runs them on every push to main and on pull requests.
