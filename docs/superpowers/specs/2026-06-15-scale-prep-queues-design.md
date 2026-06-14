# Scale-prep: web/worker split, job queues, cron safety, graceful shutdown

**Date:** 2026-06-15
**Status:** Design — pending review
**Scope:** Backend (`server/`) + `packages/db` pool. Frontend image-upload "processing" UX (admin `client/`). No microservices.

## Why

FarmFlow runs as a **single server** today (home VM + Dokploy). One box has a hard ceiling
(CPU/RAM/network) and is a single point of failure. The way past it is **horizontal
scaling**: run many identical copies of the same app behind a load balancer. This is NOT
microservices — it is one codebase, run as N copies.

The moment there are 2+ copies, several things that work silently on one box break:

1. **Crons double-fire.** Three `@Cron` jobs run on a clock. Every copy has the same clock,
   so 3 copies = the daily digest emailed **3×** to every farmer, and the slot generator
   inserting **duplicate slots**.
2. **Slow work clogs request handlers.** Outbound email / image-resize run inline inside
   request handlers. Under load the event loop spends its time on I/O the customer doesn't
   need to wait for, and a failed send is lost (no retry).
3. **DB connections exhaust.** Each copy opens a pool (pg default 10). 12 copies × 10 = 120
   > Postgres default ceiling (~100) → the whole app errors.
4. **Load balancer can't tell who's healthy.** `/health` only proves the process is alive,
   not that it can reach the DB/Redis and actually serve.
5. **Deploys drop in-flight work.** A copy told to stop dies instantly, killing a half-done
   checkout or an email job mid-send.

This spec fixes all five so that **going multi-copy is a config change, not a rewrite.**

## Goals

- Make the app **safe to run as multiple copies** (Phase A): capped DB pool, real readiness
  probe, graceful shutdown.
- Add a **job queue** (BullMQ) and a **web/worker split** so slow work is decoupled,
  retried, and independently scalable (Phases B–E).
- Make scheduled jobs **execute exactly once** across the cluster (Phase D).
- Preserve current single-box behavior exactly when `APP_ROLE` is unset (`all`).

## Non-goals (separate follow-up infra runbook)

- Migrating Postgres/Redis off the home VM to managed services.
- Load balancer provisioning, multi-VM provisioning, PgBouncer rollout.
- Microservices / splitting the domain. Explicitly rejected — wrong tool at this scale.
- Read replicas, sharding.

## Decisions (locked with the user)

| Decision | Choice |
|---|---|
| Web/worker topology | **`APP_ROLE` env flag on one Docker image** (`all`/`web`/`worker`) |
| Cron single-execution | **BullMQ repeatable jobs** (single-execution by construction; no separate leader-lock) |
| Image-resize | **Queued** (included, but last + clearly deferrable phase) |
| Spec scope | **Code-only**; infra migration = separate doc |

---

## Architecture

```
                       Load Balancer
                  asks each copy: GET /health/ready
              ┌──────────────┼──────────────┐
          web copy        web copy        worker copy
        APP_ROLE=web    APP_ROLE=web    APP_ROLE=worker
        HTTP + enqueue  HTTP + enqueue  HTTP(probe only) +
        (no workers)    (no workers)    drains queues +
                                        runs repeatable crons (once)
              └──────────────┼──────────────┘
                     Redis (BullMQ queues + cache + throttler)
              ┌──────────────┼──────────────┐
          Postgres          Redis            R2
        (ONE shared,     (queue + cache)  (photos +
         capped pool)                      image temp keys)
```

- **HTTP server runs in every role** (workers need health probes). The LB only routes
  *user* traffic to `web`/`all` copies.
- **Producers (enqueue) always available** in every role → a `web` copy can enqueue email
  and image jobs; `worker` copies drain them.
- **Workers + repeatable schedulers start only when `APP_ROLE ∈ {worker, all}`.**

### `APP_ROLE` semantics

| `APP_ROLE` | HTTP listen | BullMQ Workers | Repeatable crons registered | Use |
|---|---|---|---|---|
| `all` (default) | yes | yes | yes | single box (today's behavior — unchanged) |
| `web` | yes | no | no | user-facing copies behind LB |
| `worker` | yes (probe) | yes | yes | background crew |

Implemented in `main.ts` + a small `AppRole` config helper. Worker processor providers and
the repeatable-job registrar are conditionally wired based on role (a dynamic module, or a
`runWorkers`/`autorun:false`+manual-start guard).

---

## Components

### A. DB pool cap — `packages/db/src/index.ts`

`createDb(connectionString, opts?: { max?: number })` threads `max` into `new Pool({ ... })`.
`DrizzleModule` passes `DB_POOL_MAX` (env, default `10`). `migrate.ts`/`seed.ts`/`bootstrap.ts`
keep their own small pools (one-shot, unaffected).

**Operational rule (documented in the env sample):** `instances × DB_POOL_MAX ≤ Postgres
max_connections`. Beyond that, front Postgres with PgBouncer (transaction pooling) — infra
runbook.

### B. Health — new `HealthController` + `HealthService`

- `GET /health` — cheap **liveness**: `{ status: 'ok' }` (keep existing behavior; LB liveness).
- `GET /health/ready` — **readiness**: `SELECT 1` on the pool + `redis.ping()`. 200 when both
  succeed, **503** otherwise. The LB uses this to pull a broken copy out of rotation.

Hand-rolled (matches the codebase's style) using `DB_TOKEN` + `REDIS_TOKEN`. Skip throttle on
both (`@SkipThrottle`). No new dependency.

### C. Graceful shutdown — `main.ts` + resource providers

- `app.enableShutdownHooks()` so Nest lifecycle hooks fire on SIGTERM/SIGINT.
- Shutdown order: stop accepting HTTP → BullMQ `worker.close()` (let in-flight jobs finish) →
  `pool.end()` → `redis.quit()`.
- `OnModuleDestroy` on the DB provider (`pool.end()`) and Redis provider (`redis.quit()`).
  `@nestjs/bullmq` closes its workers on shutdown when hooks are enabled.
- Document `terminationGracePeriod` expectation (Dokploy/orchestrator should allow workers to
  drain before SIGKILL).

### D. BullMQ foundation

- Deps: `bullmq`, `@nestjs/bullmq` (versions compatible with NestJS 10).
- **Dedicated Redis connection** for BullMQ with `maxRetriesPerRequest: null` (required by
  BullMQ workers) + `enableReadyCheck: false`. Same `REDIS_URL`, separate client from
  `REDIS_TOKEN` (which keeps its defaults for cache/throttler).
- `BullModule.forRootAsync` providing that connection.
- A `BullBootstrapModule` that, when role includes worker, registers processors + the
  repeatable schedulers; when web-only, registers producer queues only.

### E. `email` queue

- `EmailService.sendMail(opts)` → **enqueues** to the `email` queue (signature unchanged, so
  all 12 callers are untouched). Returns once the job is enqueued.
- `EmailProcessor` (worker) performs the real send: suppression check (moved here so it runs
  at send time) → nodemailer transport (or dev `.mail-preview` write).
- Queue opts: `attempts: 5`, exponential backoff, `removeOnComplete`/`removeOnFail` caps,
  a **rate limiter** (e.g. `limiter: { max, duration }`) sized to the Resend plan so a burst
  (newsletter / digest fan-out) never trips provider limits.
- **Behavior changes (documented):**
  - Transactional mail (password reset, order confirmation, billing-failed) becomes **async**
    (sub-second) and **at-least-once** (a worker crash mid-job can re-send; email double-send
    is low-harm — acceptable).
  - `POST /digest/test` returns "queued N" rather than "sent N".

### F. `digest` queue + cron conversion (covers cron-safety, Phase D)

- Replace all three `@Cron` jobs with **BullMQ repeatable jobs**
  (`repeat: { pattern, tz: 'Europe/Sofia' }`), registered once on worker boot (BullMQ dedupes
  the repeat key). Each occurrence enqueues exactly one job → consumed by exactly one worker →
  **single-execution by construction**. Remove `@nestjs/schedule` + `ScheduleModule`.
  - `0 7 * * *` daily-digest → fans out one `tenant-digest` job per tenant → each builds the
    owner + per-farmer digests and enqueues `email` jobs. Per-tenant retry isolation.
  - `30 6 * * *` slot materialization → repeatable job (also removes the concurrent
    double-insert risk that exists today the instant a 2nd copy runs).
  - `0 3 * * *` grace suspension → repeatable job.

### G. `image` queue (last, deferrable)

- Upload handler writes the **original** bytes to a temp R2 key, then enqueues
  `{ entityType, entityId, field, tempKey, mime, fallbackExt, cropContext }`. Returns the
  entity immediately with a `processing: true` marker.
- `ImageProcessor` (worker): read temp → `optimizeImage` (+ smart-crop where applicable) →
  write final R2 object → update the DB url column → delete the temp key.
- Touches the 7 services that call `optimizeImage` (12 sites: products ×2, farmers ×2,
  subcategories ×2, tenants, articles, newsletter) and the admin UI (placeholder while
  `processing`). Largest blast radius → ships last; can be deferred without blocking A–F.
- **Note:** sharp already runs on the libuv threadpool (does not block the JS event loop) and
  image upload is an admin/setup path, not per-delivery — so this phase has the lowest scaling
  payoff. Re-confirm at review whether to land it now or shelve as a fast-follow.

---

## Data flow examples

**Checkout email (after):** customer checks out → handler saves order + `email.enqueue(confirmation)`
→ responds fast. Worker picks the job → suppression check → send → retry on failure.

**Daily digest (after):** repeatable `0 7` fires on one worker → enqueues one `tenant-digest`
per tenant → each tenant job builds digests and enqueues N `email` jobs → email workers send,
rate-limited. No copy ever double-sends because the repeatable occurrence is consumed once.

**Photo upload (after):** admin uploads → original to temp R2 key → `image.enqueue` → entity
returns `processing:true` → UI shows placeholder → worker optimizes + swaps in final url →
next load shows the image.

## Error handling

- **Queue jobs:** bounded `attempts` + exponential backoff; failures land in the failed set
  (capped) and are logged. Email/image failures never surface to the user request.
- **Readiness:** `/health/ready` returns 503 (not throw) so the LB interprets it cleanly.
- **Shutdown:** in-flight jobs finish within the grace window; un-acked jobs return to the
  queue for another worker (at-least-once).
- **Redis down:** producers fail to enqueue → surface as 503 on the affected write path
  (rare; Redis is already a hard dependency via throttler/cache today).

## Testing

- **Unit (jest, `server/`):** pure helpers stay pure (digest renderers, pricing) — unchanged.
  New: `HealthService` (DB ok / Redis down → 503), `AppRole` parsing, email-enqueue (sendMail
  enqueues with expected payload), digest fan-out (one tenant-digest per eligible tenant),
  image-processor happy path + temp cleanup.
- **Behavior preserved:** existing digest/slots/billing tests adapt to the new entry points
  (cron body → job handler) without changing assertions on output.
- **Manual / E2E:** run `APP_ROLE=web` + `APP_ROLE=worker` locally against shared Redis;
  confirm a queued email is sent once, the digest fans out, `/health/ready` flips to 503 when
  Redis is stopped, SIGTERM drains an in-flight job.

## Phases (TDD, each independently shippable)

| Phase | Content | Ships | Risk |
|---|---|---|---|
| **A** | DB pool max + `/health/ready` + graceful shutdown | first, alone | low |
| **B** | BullMQ foundation (deps, Redis conn, `APP_ROLE` gating, worker drain) | after A | low |
| **C** | `email` queue (row 1) | after B | medium (async mail semantics) |
| **D** | crons → repeatable + digest fan-out (rows 1+2) | after C | medium |
| **E** | `image` queue (row 1) | last; deferrable | higher (7 services + UI) |

Phase A makes the app *safe* to run as multiple copies. B–D make it *correct and fast*. E is
the optional extra.

## Risks / gotchas

- **BullMQ Redis connection** MUST use `maxRetriesPerRequest: null` — do not reuse the
  `REDIS_TOKEN` client (its defaults break workers).
- **`@nestjs/bullmq` ↔ NestJS 10** version compatibility — pin a known-good pair.
- **At-least-once** delivery: design email/image handlers to be safe on re-run (idempotent
  url overwrite; double email tolerated).
- **`APP_ROLE` default must equal today's behavior** (`all`) so existing single-box deploy is
  untouched until the user opts in.
- **Repeatable-job timezone**: keep `tz: 'Europe/Sofia'` to match current `@Cron` behavior.
- This machine flakes when jest + next build + server run in parallel — run verification
  sequentially.
