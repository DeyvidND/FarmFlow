<!-- last-verified: 2026-07-14 | invariants: files=client/src/app/layout.tsx,client/src/lib/api-client.ts -->

# client — `@fermeribg/web` (Next.js App Router)

The **main FarmFlow panel** — the app farmers/operators log into to run a farm:
products, orders, availability, delivery, payments, stats, site editing. Also hosts
customer-facing order views (`my-orders`, `my-report`). This is the biggest frontend.

## Run

```bash
pnpm --filter @fermeribg/web dev     # next dev
pnpm --filter @fermeribg/web test    # unit
pnpm --filter @fermeribg/web e2e      # playwright
pnpm --filter @fermeribg/web build
```

## Layout

- `src/app/(admin)/*` — the panel routes (dashboard, orders, products, farmers,
  slots, availability, route, payments, newsletters, stats, settings, setup, …).
  Despite the `(admin)` group name, this is the **farmer/operator** panel, not the
  super-admin console (that's the separate `admin` app).
- `src/app/(auth)/*` — login / auth screens.
- `src/app/bff/[...path]` — **BFF proxy**: the browser calls same-origin `/bff/*`,
  which forwards to `@fermeribg/api`. Keeps the API origin private and dodges
  the origin-api firewall in the browser. All three Next apps use this pattern.
- `src/app/api/*` — Next route handlers (server-only helpers, not the domain API).
- `src/components/*` — one folder per feature area (mirrors the routes).
- `src/lib/` — `api-client.ts` (calls the BFF), `session.ts` (auth), data helpers.

## Conventions

- **Talk to the backend through the BFF** (`/bff/...`), not directly to the API host.
  `PUBLIC_*` base URLs branch on `typeof window` — server-side calls the API host,
  browser calls `/bff`. Don't hardcode the API origin in browser code.
- Feature components live under `src/components/<area>/` matching the route group.
- Mobile matters: this panel is used on phones; check 375px. Screenshots via the
  in-app Browser pane can time out — measure the DOM instead when that happens.

## Related

- Super-admin console → [`../admin/CLAUDE.md`](../admin/CLAUDE.md)
- Courier app → [`../delivery-web/CLAUDE.md`](../delivery-web/CLAUDE.md)
- The public storefront is **chaika**, a separate Cloudflare Workers repo — not here.
