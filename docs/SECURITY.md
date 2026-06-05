# Rate limiting, DoS / DDoS posture

Audit + the controls implemented in the API. Scope here is the **NestJS backend**
(`server/`), which is where every storefront and admin request ultimately lands.

## What was missing (pre-audit)

- **No rate limiting** anywhere — `/auth/login`, `/platform/auth/login`, password
  reset, public checkout, reviews and contact were all unbounded → brute-force and
  spam were free.
- **Unbounded file uploads** — every `FileInterceptor('image')` ran with no size
  limit, so one large multipart body could exhaust memory.
- **No security headers** (no helmet) and `X-Powered-By` advertised the stack.
- **No `trust proxy`**, so per-IP limiting behind a proxy would have keyed on the
  proxy IP (everyone in one bucket).

## What is now in place (app layer)

### Distributed rate limiting (`@nestjs/throttler` + Redis)
- Backed by the app's existing Redis (`REDIS_URL` is required), via a custom atomic
  Lua storage (`server/src/common/throttler/redis-throttler.storage.ts`). Limits are
  therefore **shared across all instances** and survive restarts — in-memory would
  reset per process/deploy.
- `ThrottlerGuard` is the **first** global guard, so floods are rejected before any
  auth or DB work. Keyed on client IP. Responses carry `X-RateLimit-*`; throttled
  requests get `429` + `Retry-After`.
- **Global backstop:** `RATE_LIMIT_DEFAULT` (default **300** / `RATE_LIMIT_TTL_MS`,
  default 60 s) per IP on everything.
- **Tightened routes** (per IP / minute):

  | Route | Limit | Why |
  |---|---|---|
  | `POST /auth/login`, `POST /platform/auth/login` | 10 | brute force |
  | `POST /auth/change-password`, `/platform/change-password`, `/auth/reset-password` | 10 | credential abuse |
  | `POST /auth/forgot-password` | 5 | reset-email spam / enumeration |
  | `POST /public/:slug/checkout`, `POST /public/:slug/orders` | 15 | costly (DB + live Econt + Stripe) |
  | `POST /public/:slug/reviews` | 8 | spam |
  | `POST /public/:slug/newsletter`, `/contact` | 5 | spam (sends email) |
  | `GET /public/:slug/econt/offices` | 30 | proxies the live Econt API |

- **Skipped** (`@SkipThrottle`): `POST /stripe/webhook` and `POST /email/webhook` —
  both signature/secret-verified and idempotent; rate-limiting them would drop
  legitimate Stripe/SNS retry bursts.
- **Kill switch:** `RATE_LIMIT_DISABLED=true`.

### Upload limits
Global `MulterModule.register({ limits: { fileSize: MAX_UPLOAD_MB·MB, files: 1 } })`
(default **8 MB**). Inline `FileInterceptor` calls inherit it.

### Headers / hardening (`helmet`)
HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options`, COOP, `X-Powered-By`
removed. CSP is off (JSON API + Swagger UI; CSP belongs on the storefronts).
`Cross-Origin-Resource-Policy: cross-origin` so browsers on other origins can still
read the world-readable `/public/*` catalog.

## Deployment: `TRUST_PROXY` (read before prod)

Per-IP limits are only correct if the API sees the **real client IP**.
- Direct exposure / local dev → leave `TRUST_PROXY` empty (safe; X-Forwarded-For
  can't be spoofed to rotate IPs).
- Behind N proxies (nginx, Cloudflare, a load balancer) → set `TRUST_PROXY` to the
  **hop count** (usually `1`). If unset behind a proxy, every client shares one
  bucket and trips the global limit together. Do **not** set it higher than the real
  hop count — that lets attackers spoof XFF to dodge limits.

## The edge / CDN boundary (important)

App-layer per-IP limiting **cannot** stop a volumetric (L3/L4 or large L7) DDoS, and
it deliberately does **not** hard-limit cached public **GET** catalog reads — the
Astro storefront does SSR from a **single IP**, so a tight per-IP cap there would
throttle the whole shop. Those reads are already cached (`Cache-Control` /
`s-maxage`, see `server/src/main.ts`) and should sit behind a CDN.

Volumetric DDoS protection is an **edge** concern. Recommended:
- Put Cloudflare (or equivalent) in front of both the API and the storefronts;
  enable its DDoS protection + a WAF rate-limit rule on `/public/*`.
- Cache `/public/*` GETs at the edge (the `s-maxage` headers are already set).
- Set `TRUST_PROXY` to match the edge hop count.

The app-layer limits above are the **second** line (abuse, brute force, spam,
app-cost protection) and stay correct behind the edge.
