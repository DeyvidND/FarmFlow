<!-- last-verified: 2026-07-14 | invariants: files=admin/src/app/layout.tsx,admin/src/lib/api-client.ts -->

# admin — `@fermeribg/admin` (Next.js App Router)

The **super-admin console** — the platform operator's view across *all* tenants:
farms/tenants, producers, marketplace finance, billing, platform health. Not the
farmer panel (that's `client`).

## Run

```bash
pnpm --filter @fermeribg/admin dev
pnpm --filter @fermeribg/admin build
```

## Layout

- `src/app/(panel)/*` — the console: `tenants`, `producers`, `producers-map`,
  `marketplace-finance`, `email-billing`, `stripe`, `insights`, `audit`, `health`,
  `problems`, `delivery`, `dashboard`, `settings`.
- `src/app/(auth)/*` — login.
- `src/app/bff/*` — BFF proxy to `@fermeribg/api` (same pattern as `client`).
- `src/components/`, `src/hooks/`, `src/lib/` (`api-client.ts`, `session.ts`).

## Conventions

- Same BFF rule as the other Next apps: browser → `/bff/*` → API. Don't hit the API
  origin directly from browser code.
- This app spans tenants, so its endpoints are the ones that legitimately read
  cross-tenant. Backend guards still enforce who may call them — don't loosen those.
- Producers nest under farms in the nav; "Финанси" (finance) lives here.

## Related

- Farmer panel → [`../client/CLAUDE.md`](../client/CLAUDE.md)
- Backend it drives → [`../server/CLAUDE.md`](../server/CLAUDE.md)
