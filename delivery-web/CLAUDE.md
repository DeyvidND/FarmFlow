<!-- last-verified: 2026-07-14 | invariants: files=delivery-web/src/app/layout.tsx,delivery-web/src/lib/api-client.ts -->

# delivery-web — `@fermeribg/delivery-web` (Next.js App Router)

The **dostavki courier app** — the delivery/logistics view: shipments, imports,
COD-risk. A focused app separate from the farmer panel and super-admin console.

## Run

```bash
pnpm --filter @fermeribg/delivery-web dev
pnpm --filter @fermeribg/delivery-web build
```
Local backend for this app historically runs on port **3100** (dostavki).

## Layout

- `src/app/(panel)/*` — `shipments`, `import`, `cod-risk`, `help`, `settings`.
- `src/app/(auth)/*` — login (SSO with the main app; deliveries were migrated to a
  dostavki SSO flow).
- `src/app/bff/*` — BFF proxy to `@fermeribg/api` (same pattern as the other apps).
- `src/components/`, `src/lib/` (`api-client.ts`, `session.ts`).

## Conventions

- BFF rule applies (browser → `/bff/*` → API).
- Delivery/courier server logic lives in the API under `modules/econt`, `econt-app`,
  `speedy`, `routing`, `handover`, `cod-risk` — this app is the courier-facing UI on
  top of those. See [`../server/CLAUDE.md`](../server/CLAUDE.md).

## Related

- Delivery flow end-to-end → [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
