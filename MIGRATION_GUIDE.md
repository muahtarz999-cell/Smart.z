# Cloudflare Workers deployment

Smart.z uses OpenNext for Cloudflare Workers. It does not use the legacy Pages output directory `.vercel/output/static`.

## Required GitHub Actions secrets

Add these repository secrets under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN`: a token allowed to deploy Workers for this account
- `CLOUDFLARE_ACCOUNT_ID`: the Cloudflare account ID

Do not commit application API keys, Supabase service-role keys, or Cloudflare tokens. Configure runtime secrets separately with Wrangler, for example:

```bash
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

## Local commands

```bash
npm ci
npm test
npm run worker:build
npm run deploy
```

The Worker entry point is `.open-next/worker.js`, and static assets are emitted to `.open-next/assets` as configured in `wrangler.toml`.

## Cloudflare dashboard

Use a Cloudflare Workers deployment for this project. Do not configure a Pages output directory such as `.vercel/output/static`. Keep the existing Pages project until the Worker has been deployed and verified in production.
