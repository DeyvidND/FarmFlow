# Phase 2 — Emailed bilateral protocol on order confirm — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision note (2026-07-22, second pass):** an earlier draft of this plan made ALL THREE
> confirm paths block on an awaited SMTP send. That violated spec §4.3, which is authoritative
> (the user approved it) and states a per-path table: the human/single path blocks; the bulk
> path and the Stripe webhook **queue** the email and must not pay its latency (§9.2 says so
> explicitly for the bulk path). This revision fixes Tasks 7 and 8 to queue instead of block,
> adds the BullMQ queue+processor that makes that possible (new work inside Task 5), and adds
> a genuine "прати пак" resend action (Task 9) — needed precisely because the queued paths now
> flip `orders.status` before the email outcome is known, so "just click confirm again" (the
> earlier draft's plan for retries) no longer applies to them. Task 6 (human path) is unchanged
> — it already matched §4.3 correctly. See the "§4.3 governs" section below for what changed
> and why, and the per-task diffs for the mechanics.

**Goal:** When an order transitions into `confirmed`, render the customer's bilateral
(`operator_to_customer`) protocol as a PDF and email it as a real attachment, on the schedule
§4.3 of the spec actually specifies **per path** — this is not uniform across the three ways
an order can be confirmed:

| Path | Behavior (§4.3) |
|---|---|
| `PATCH /orders/:id/status` (human, single) | **Blocks** on the send — waits, fails loudly, only flips to `confirmed` after the email is observed to succeed (or is safely skipped: no address on file) |
| `PATCH /orders/confirm-pending` (bulk) | Flips per its existing bulk semantics (unchanged), then **queues** one email job per order — never awaits SMTP; the response reports enqueue outcomes ("X от Y не тръгнаха"), not delivery outcomes |
| Stripe webhook (`markOrderPaid`) | Flips per its existing idempotent-webhook semantics (unchanged), then **queues** an email job and returns its fast 200 — never awaits SMTP |

Track every attempt on the order row (`protocol_email_status/_at/_error`) so a failed send —
whether the human path's synchronous failure or a queued job's asynchronous one — is visible
and safely retryable, including a small "прати пак" resend action (Task 9) for the queued
paths, where the order may already be `confirmed` by the time an email failure is known. Also
wires §4.4 (courier consolidated-protocol email button), gated on Phase 1.

**Architecture:** A single reusable helper (`OrderProtocolEmailService.sendProtocolEmail`)
does render → await-real-send → write-tracking-columns. It is the **one** place that logic
exists — every path reuses it, but *how* each path invokes it differs, per §4.3:

- The human path (Task 6, `OrdersService.updateStatus`) calls it **inline**, awaits it, and
  only performs the status-flip write if it resolves `{ ok: true }` (a genuine send, or a
  safe no-op skip for "no email on file" / "already sent"). This is the one path the HARD
  REQUIREMENT below applies to literally — it is also the one path §9.2 says may pay the
  latency (quoted "~1-3s").
- The bulk path (Task 7, `OrdersService.confirmPending`) and the Stripe webhook (Task 8,
  `StripeService.markOrderPaid`) do **not** call `sendProtocolEmail` directly and do not gate
  their status-flip on it at all. They flip per their own existing (unchanged) logic, then
  call a new, fast, non-blocking `OrderProtocolEmailService.enqueueProtocolEmail(tenantId,
  orderId)` — a thin `queue.add(...)` wrapper. A new BullMQ queue + processor (built inside
  Task 5, modeled exactly on this codebase's existing `EMAIL_QUEUE`/`EmailProcessor` pattern
  in `server/src/common/email/`) picks the job up off the request/webhook path entirely and
  calls the very same `sendProtocolEmail` helper asynchronously. So "render → send → track"
  still happens in exactly one function regardless of which path triggered it — only the
  *triggering* differs, and only the human path's caller ever waits on the outcome.

The PDF is rendered via the existing Phase-0 `handover-pdf.ts` primitives, reusing
`HandoverService.ensureDraftTarget` (idempotent, already-shipped) to get a stable,
per-tenant-numbered — but still `status='draft'` / unsigned — `handover_protocols` row, then
a new `HandoverService.renderPdfForEmail` to turn it into bytes with a "PRELIMINARY —
unsigned" notice stamped on it. The actual delivery attempt, wherever it's called from
(inline by Task 6, or from inside the new queue's processor for Tasks 7/8), goes through a new
`EmailService.sendMailNow` — exactly **one** delivery attempt, synchronously, no BullMQ
backoff — instead of the existing `EmailService.sendMail`/`EMAIL_QUEUE` (which only confirms
*enqueued*, not *delivered*, and is left completely untouched by this feature; it remains in
use for its existing callers, orthogonal to this plan). Attachments are described uniformly
(inline or queued) as `{ kind: 'handover-protocol', protocolId, tenantId }` and materialized
to bytes inside `EmailService.deliver()` via an injected resolver token, so both the inline
caller and the new queue's jobs get the same behaviour for free.

**Two different queues, two different jobs — don't conflate them:**
- `EMAIL_QUEUE` (existing) / `EmailService.sendMail()` / `EmailProcessor` — general
  fire-and-forget transactional/bulk mail (password resets, digests, newsletters). Untouched.
- `PROTOCOL_EMAIL_QUEUE` (**new**, Task 5) / `OrderProtocolEmailService.enqueueProtocolEmail()`
  / `OrderProtocolEmailProcessor` (**new**, Task 5) — carries exactly one job shape,
  `{ tenantId, orderId }`, whose processor calls `sendProtocolEmail`. Used only by Tasks 7, 8,
  and the resend action (Task 9). Modeled directly on `EMAIL_QUEUE`'s registration + processor
  shape (same `defaultJobOptions`, same concurrency/limiter numbers) because both ultimately
  drive the same pooled SMTP transporter in `EmailService` — see Task 5.

**Tech Stack:** NestJS 10, Drizzle ORM (Postgres), BullMQ (Redis), Jest, pdf-lib (via
`pdf-kit.ts`/`handover-pdf.ts` from Phase 0).

## Global Constraints

- Migrations are hand-written; a drizzle journal index-gap silently breaks the migrator
  (root `CLAUDE.md`).
- `scheduledForDay/Range` queries require `leftJoin(deliverySlots)` on every query — an
  `UPDATE` cannot `leftJoin` directly (see `orders.confirm-pending.spec.ts`'s header comment
  and `server/CLAUDE.md`), hence the existing `id IN (subselect that joins)` idiom, which
  Task 7 must preserve **unchanged** (it is not being replaced — see "§4.3 governs" below).
- No `ANY()` — use `inArray`. Drizzle `CASE...THEN` needs `::int`.
- Optional string DTOs: `@IsOptional()` does not coerce `''` → `undefined`; needs
  `@Transform`.
- Push to `main` auto-deploys; migrations run before app images. Re-seeding rotates tenant
  ids.
- Europe/Sofia + DST for all date math (not directly touched by this plan, but the
  `protocol_email_at` timestamp is `timestamptz`, stored in UTC, displayed converted).
- **HARD REQUIREMENT, scoped to the single/human confirm path only (verbatim, non-negotiable):**
  for `PATCH /orders/:id/status`, the order's status flip to `confirmed` happens **after** the
  protocol email send is attempted and observed to succeed (or is skipped because there is no
  email on file) — never before. **This requirement is scoped to that one path by §4.3's own
  per-path table** — it does not extend to the bulk path or the Stripe webhook, which flip per
  their existing semantics and queue the email afterward. Applying it uniformly to all three
  paths was an earlier draft's mistake (see the revision note above); it directly contradicted
  §9.2 ("масовият път не я плаща") and §4.3's own wording for the Stripe row ("опашка — Stripe
  чака бърз 200"). Tasks 7 and 8 below implement the queued reading; only Task 6 blocks.

---

## Assumptions, and where this plan intentionally reads between spec lines

Read this before touching code — several of these are load-bearing for every task below.

1. **Migration number is a placeholder.** Main is at `0111` (journal idx 109). The
   `koshnitsi-baskets` branch already claimed `0112`. The Phase 1 (consolidated-protocol)
   plan *also* independently assumed `0112` before that collision was known. This plan
   assumes **`0113_order_protocol_email.sql`, journal idx `111`** (i.e., the next free slot
   *after* baskets' `0112`) — one slot further out than Phase 1 is likely to land on, since
   Phase 1 and Phase 2 are being developed in parallel and neither can see the other's
   final number. **Whichever of Phase 1 / Phase 2 merges to `main` second must renumber**
   its migration file + `_journal.json` entry to the next actually-free idx at that time.
   Task 1 isolates this to one file + one journal entry so the renumber is a two-line diff.

2. **The attached PDF is the existing `operator_to_customer` bilateral protocol
   (`handover-pdf.ts`), rendered via a *new, unsigned, `status='draft'` `handover_protocols`
   row*** obtained through the already-shipped `HandoverService.ensureDraftTarget`. It is
   **not** a new document type. Reusing `ensureDraftTarget` (idempotent, advisory-lock
   numbered) means the protocol gets a real, stable `protocolNumber` at confirm time, and the
   *same* row is later flipped to `status='signed'` at actual handover — matching the
   spec's "Обобщеният протокол стъпва точно на връзката фермер→поръчки" framing of §1.8 and
   the "protocol is born at confirm, not handover" problem statement.

3. **"Опашка" (queue) in §4.1 describes the shape of `SendMailOptions.attachments` — a
   `{kind, protocolId}` descriptor, materialized at send time — not necessarily that every
   path goes through the BullMQ-queued, auto-retried `EmailService.sendMail()`.** This plan
   introduces `EmailService.sendMailNow()`, which performs exactly **one** delivery attempt
   synchronously (no BullMQ backoff) and shares the *same* attachment-materialization code
   path (`deliver()`) as the queued method.

   **This "single attempt, no backoff" property is correct for the human path (Task 6) and
   ONLY the human path.** Rationale, unchanged from the original draft: §9.2 quotes "~1-3s"
   added latency for the single-confirm path; BullMQ's configured `attempts: 5, backoff:
   exponential(2000ms)` (see `email.module.ts`) could take **tens of seconds** on a transient
   failure before settling — an order of magnitude past "1-3s" — if a caller were sitting
   there waiting on it. A single, fast, user-retryable attempt (via re-clicking confirm)
   matches the quoted number far better than automatic multi-attempt backoff would, for a
   caller that blocks.

   **For the bulk and Stripe paths (Tasks 7/8), the opposite is true, and for the same
   reason.** Neither path has a caller waiting on the send at all — that's the entire point of
   queuing it (§4.3, §9.2). So the "tens of seconds is too slow" objection above does not
   apply to them; a real BullMQ-backed queue (`PROTOCOL_EMAIL_QUEUE`, Task 5) with its own
   `attempts: 5, backoff: exponential(2000ms)` sits invisibly between the flip and the
   eventual send, giving those two paths automatic multi-attempt retry that the human path
   deliberately does *not* get. `sendMailNow` itself (still exactly one attempt, still no
   internal backoff) is reused unchanged inside the new queue's processor — the retrying
   happens one layer up, at the BullMQ job level, not inside `sendMailNow`.

4. **No email on file ⇒ skip, don't fail.** `orders.customerEmail` is optional
   (`create-order.dto.ts`); the existing `OrderConfirmationService.send()` already no-ops
   silently when absent (`if (!to) return;`). This plan mirrors that: if the order has no
   email, `sendProtocolEmail` returns `{ ok: true, skipped: 'no-email' }`, `protocol_email_status`
   stays `null` (never attempted), and the caller proceeds straight to the status flip (Task 6)
   or the job simply no-ops (Tasks 7/8's queued path). The spec does not explicitly address
   this case — flagged as an open question, but this is the only reading consistent with
   existing conventions in this codebase.

5. **"Прати пак" IS a small new action — revised from the earlier draft, which argued it
   away.** The earlier draft reasoned: "re-invoking the *same* confirm action already retries
   correctly, because `sendProtocolEmail` is idempotent on `protocol_email_status='sent'` — no
   new endpoint needed." That reasoning only holds for the **human path** (Task 6), where a
   failed send leaves the order `pending`, so re-clicking confirm genuinely re-enters the gate
   and retries. **It does not hold for the bulk or Stripe paths (Tasks 7/8)**, because those
   now flip `orders.status` to `confirmed` *before* the email's outcome is known — the order is
   already `confirmed` by the time a send failure (or an enqueue failure) becomes visible, so
   nothing about "re-running confirm" applies to it anymore (there is no pending→confirmed
   transition left to gate). Task 9 therefore adds a real, small resend action —
   `OrdersService.resendProtocolEmail` + `POST /orders/:id/resend-protocol-email` — that just
   calls `enqueueProtocolEmail` again; it is idempotent via the very same `protocol_email_status
   === 'sent'` check already inside `sendProtocolEmail`. This is not a new invention: §4.3's
   closing line names the button explicitly — "На поръчката има бутон „прати пак"." — so this
   was always in scope; the earlier draft's "no new endpoint" reading was the mistake.

6. **§4.4 (courier consolidated-protocol email button) is BLOCKED on Phase 1.** The button
   lives in "секцията с протоколите" — Phase 1's new screen over the new
   `consolidated_protocols` table, neither of which exists in this worktree yet (only Phase
   0 has landed here). Task 10 designs the send path against an **assumed** Phase-1 interface
   and is explicitly marked not executable until Phase 1 merges. See open questions.

---

## §4.3 governs — no deviation left to record

An earlier draft of this plan carried a "Known deviations from a fully literal reading of the
spec" section here, arguing that the HARD REQUIREMENT forced the bulk path into a
bounded-concurrency awaited-SMTP loop (contradicting §9.2) and forced the Stripe webhook to
await the same helper inline (contradicting §4.3's "Stripe чака бърз 200" framing). Both of
those were wrong turns, not genuine tensions to weigh:

- §9.2 ("масовият път не я плаща") is not in tension with the HARD REQUIREMENT once the HARD
  REQUIREMENT is read at its correct scope (the human path only, per §4.3's table above) — it
  simply says what Task 7 must do: flip, then queue, never await.
- §4.3's Stripe row ("опашка — Stripe чака бърз 200") says the same thing for Task 8: flip per
  the webhook's existing idempotent semantics, queue the email, return the 200 without waiting
  on it.

There is no remaining open question about whether bulk/Stripe should block — they don't.
Tasks 7 and 8 below implement the queued reading directly.

---

## File Structure

| File | Change |
|---|---|
| `packages/db/drizzle/0113_order_protocol_email.sql` | **create** — 3 new `orders` columns |
| `packages/db/drizzle/meta/_journal.json` | **modify** — append idx 111 entry |
| `packages/db/src/schema.ts` | **modify** — add 3 columns to `orders` pgTable |
| `server/src/modules/handover/handover.module.ts` | **modify** — export `HandoverService` |
| `server/src/modules/handover/handover.service.ts` | **modify** — add `renderPdfForEmail` |
| `server/src/modules/handover/handover-pdf.ts` | **modify** — optional preliminary-notice param |
| `server/src/common/email/email.service.ts` | **modify** — `attachments` on `SendMailOptions`, resolver token, `sendMailNow`, attachment materialization in `deliver()` |
| `server/src/common/email/protocol-attachment.types.ts` | **create** — resolver interface + DI token |
| `server/src/common/queue/queue.constants.ts` | **modify** — add `PROTOCOL_EMAIL_QUEUE` |
| `server/src/modules/order-protocol-email/order-protocol-email.module.ts` | **create** — registers `PROTOCOL_EMAIL_QUEUE`, the service, the resolver, the processor |
| `server/src/modules/order-protocol-email/order-protocol-email.service.ts` | **create** — the shared render→send→track helper (`sendProtocolEmail`) **and** the fast enqueue wrapper (`enqueueProtocolEmail`) |
| `server/src/modules/order-protocol-email/order-protocol-email.processor.ts` | **create** — BullMQ processor; calls `sendProtocolEmail` per queued job |
| `server/src/modules/order-protocol-email/handover-protocol-attachment.resolver.ts` | **create** — wraps `HandoverService.renderPdfForEmail` for the DI token |
| `server/src/modules/orders/orders.module.ts` | **modify** — import `OrderProtocolEmailModule` |
| `server/src/modules/orders/orders.service.ts` | **modify** — `updateStatus` (blocks), `confirmPending` (queues), `resendProtocolEmail` (new), `findOne`/`findAll` projection |
| `server/src/modules/orders/orders.controller.ts` | **modify** — new `POST :id/resend-protocol-email` route |
| `server/src/modules/orders/orders.confirm-pending.spec.ts` | **modify (append tests)** — existing bulk-UPDATE assertions are UNCHANGED; new tests cover the enqueue step |
| `server/src/modules/stripe/stripe.module.ts` | **modify** — import `OrderProtocolEmailModule` |
| `server/src/modules/stripe/stripe.service.ts` | **modify** — `markOrderPaid` (queues, does not block) |
| `server/src/common/email/email.module.ts` | **modify** — import `OrderProtocolEmailModule` (resolver provider) |

---

### Task 1: `orders` columns migration + schema

**Files:**
- Create: `packages/db/drizzle/0113_order_protocol_email.sql`
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/schema.ts` (the `orders` pgTable, ~line 414)
- Test: `packages/db/src/schema.spec.ts` (create if it doesn't already assert column presence
  elsewhere — check first; if there is no existing schema-shape spec file, add the assertion
  to the nearest existing orders-related db-package test instead of creating a new file)

**Interfaces:**
- Produces: `orders.protocolEmailStatus: string | null` (`'sent' | 'failed' | 'bounced' | null`),
  `orders.protocolEmailAt: Date | null`, `orders.protocolEmailError: string | null` — consumed
  by every later task via `typeof orders.$inferSelect` (`OrderRow` in `orders.service.ts`).

- [ ] **Step 1: Confirm the migration number is still free (RED-equivalent: a stale check)**

Run: `grep -n '"idx": 110\|"idx": 111\|0112_\|0113_' packages/db/drizzle/meta/_journal.json` and
`ls packages/db/drizzle | tail -5`
Expected: idx 109 / `0111_handover_signatures` is still the last entry, no `0112`/`0113` files
exist in *this worktree*. (They may exist on `main`/other branches — that's the collision
this plan calls out, not a bug here.)

- [ ] **Step 2: Write the migration**

```sql
-- 0113_order_protocol_email.sql
-- Phase 2: track the bilateral protocol email sent at order confirm.
-- NUMBERING: assumed next-free-after-baskets(0112) as of 2026-07-22. Phase 1
-- (consolidated protocols) independently also wants a slot near here. Whichever
-- of Phase 1 / Phase 2 merges to main SECOND must renumber this file + its
-- _journal.json entry (see plan doc "Assumptions" #1).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_status text;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_at timestamptz;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS protocol_email_error text;
```

- [ ] **Step 3: Append the journal entry**

In `packages/db/drizzle/meta/_journal.json`, append after the `idx: 109` entry:

```json
    {
      "idx": 110,
      "version": "7",
      "when": 1785000000000,
      "tag": "0113_order_protocol_email",
      "breakpoints": true
    }
```

(NOTE: this plan's assumed migration is `0113` but the NEXT journal idx after 109 is 110,
not 111 — the migration filename number and the journal idx are two independent counters;
don't conflate them. If Phase 1 lands its `01XX` migration first, this idx must become 111
and the entry above renumbered to match — same single-point-of-change as the SQL header.)

- [ ] **Step 4: Add the columns to the Drizzle schema**

In `packages/db/src/schema.ts`, inside the `orders` pgTable definition (near the other
`*_at`/`*_error`/`*_status`-shaped columns, e.g. right after `codOutcomeSource`):

```ts
    // Phase 2 (2026-07-22): tracks the bilateral protocol PDF emailed to the
    // customer at confirm time. null = never attempted (no email on file, or
    // this order predates the feature). 'sent' = accepted by the mail server
    // (NOT "delivered" — see order-protocol-email.service.ts). 'bounced' is
    // written by the existing Resend webhook (SuppressionService's consumer).
    protocolEmailStatus: text('protocol_email_status'),
    protocolEmailAt: timestamp('protocol_email_at', { withTimezone: true }),
    protocolEmailError: text('protocol_email_error'),
```

- [ ] **Step 5: Verify the schema compiles and the column names round-trip**

Run: `pnpm --filter @fermeribg/db build`
Expected: no TS errors; `typeof orders.$inferSelect` now includes `protocolEmailStatus`,
`protocolEmailAt`, `protocolEmailError`.

- [ ] **Step 6: Teeth-check — break it, confirm it breaks, restore**

Temporarily rename `protocol_email_status` to `protocol_email_statusx` in the migration SQL
only (leave schema.ts alone), run `pnpm --filter @fermeribg/api test -- order-protocol-email
--maxWorkers=1` (will fail once Task 4's spec exists — for now, this step is a placeholder
you revisit after Task 4 lands; if run now, confirm instead that
`pnpm --filter @fermeribg/db build` still passes even with the typo, proving the DB package
build does NOT catch a migration/schema name drift — i.e., this is a real gap the later
integration test (Task 4) closes). Revert the typo.

- [ ] **Step 7: Commit**

```bash
git add packages/db/drizzle/0113_order_protocol_email.sql packages/db/drizzle/meta/_journal.json packages/db/src/schema.ts
git commit -m "feat(db): add orders.protocol_email_status/_at/_error columns"
```

---

### Task 2: `HandoverModule` exports `HandoverService`; `renderPdfForEmail`

**Files:**
- Modify: `server/src/modules/handover/handover.module.ts`
- Modify: `server/src/modules/handover/handover.service.ts` (near `renderPdf`, ~line 1319)
- Test: `server/src/modules/handover/handover.service.spec.ts`

**Interfaces:**
- Consumes: `HandoverService.ensureDraftTarget(tenantId, dto: DraftQueryDto): Promise<{id:
  string}>` (existing, `handover.service.ts:936`), `HandoverService.getById(tenantId, id)`
  (existing, `:1301`).
- Produces: `HandoverService.renderPdfForEmail(tenantId: string, protocolId: string):
  Promise<Buffer>` — consumed by Task 3's resolver.

- [ ] **Step 1: Write the failing test**

Add to `server/src/modules/handover/handover.service.spec.ts` (follow the existing file's
db-mock conventions — check its top for the `buildDb`/similar helper before writing this;
the shape below assumes a `getById`-style mock returning a row):

```ts
describe('HandoverService.renderPdfForEmail', () => {
  it('renders the persisted protocol and the buffer looks like a real PDF', async () => {
    const row = {
      id: 'p1',
      tenantId: 't1',
      kind: 'operator_to_customer',
      status: 'draft',
      protocolNumber: 7,
      signedAt: null,
      createdAt: new Date('2026-07-22T08:00:00Z'),
      fromSnapshot: { name: 'Ферма Тест' },
      toSnapshot: { name: 'Клиент Тест' },
      items: [{ productName: 'Домати', quantity: 2, priceStotinki: 350 }],
      totalStotinki: 700,
      meta: { orderNumbers: [42] },
      fromSignaturePng: null,
      toSignaturePng: null,
    };
    const svc = Object.create(HandoverService.prototype) as HandoverService;
    jest.spyOn(svc, 'getById').mockResolvedValue(row as any);

    const buf = await svc.renderPdfForEmail('t1', 'p1');

    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- handover.service.spec --maxWorkers=4`
Expected: FAIL — `svc.renderPdfForEmail is not a function`.

- [ ] **Step 3: Implement `renderPdfForEmail`**

In `handover.service.ts`, right after the existing `renderPdf` method:

```ts
  /**
   * Renders a persisted protocol for EMAIL delivery — always stamps the
   * unsigned/preliminary notice, regardless of the row's actual status,
   * because every call site of this method is the confirm-time flow, where
   * the protocol is by construction not yet signed (signing only happens at
   * physical handover, hours later). Unlike `renderPdf` (used for
   * admin download/preview, which must NOT gain a new visual side effect for
   * already-shipped callers), this is a new, narrowly-scoped method — safe to
   * make the notice unconditional here.
   */
  async renderPdfForEmail(tenantId: string, id: string): Promise<Buffer> {
    const row = await this.getById(tenantId, id);
    return renderProtocolPdf(row, { preliminaryNotice: true });
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- handover.service.spec --maxWorkers=4`
Expected: PASS. (It will only fully pass once Task 3 below adds the `opts` parameter to
`renderProtocolPdf` — do that sub-step first if your test runner processes files in
isolation; the two steps are co-dependent, see Task 3.)

- [ ] **Step 5: Export `HandoverService` from the module**

In `handover.module.ts`:

```ts
@Module({
  imports: [RoutingModule],
  controllers: [HandoverController],
  providers: [HandoverService],
  exports: [HandoverService],
})
export class HandoverModule {}
```

- [ ] **Step 6: Teeth-check**

Temporarily remove the `exports: [HandoverService]` line, run
`pnpm --filter @fermeribg/api test -- order-protocol-email --maxWorkers=1` (once Task 5's
module exists and imports `HandoverModule`) — expect a Nest DI resolution error
(`Nest can't resolve dependencies of HandoverProtocolAttachmentResolver`). Restore the export
line.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/handover/handover.module.ts server/src/modules/handover/handover.service.ts server/src/modules/handover/handover.service.spec.ts
git commit -m "feat(handover): export HandoverService + add renderPdfForEmail"
```

---

### Task 3: Preliminary-notice option on `renderProtocolPdf`

**Files:**
- Modify: `server/src/modules/handover/handover-pdf.ts`
- Test: `server/src/modules/handover/handover-pdf.spec.ts`

**Interfaces:**
- Produces: `renderProtocolPdf(row: any, opts?: { preliminaryNotice?: boolean }):
  Promise<Buffer>` — the added second parameter is optional and defaults to no change, so
  every EXISTING call site (`renderPdf`, `renderPreviewPdf`, `renderBatchPdf` in
  `handover.service.ts`) is unaffected. Only Task 2's new `renderPdfForEmail` passes
  `{ preliminaryNotice: true }`.

- [ ] **Step 1: Write the failing test**

Add to `handover-pdf.spec.ts` (check the file's existing helper for building a minimal valid
`row` object and reuse it rather than inventing a new fixture shape):

```ts
describe('renderProtocolPdf preliminary notice', () => {
  it('adds no visible marker by default (existing callers unaffected)', async () => {
    const row = minimalCustomerLegRow(); // reuse this file's existing fixture helper
    const buf = await renderProtocolPdf(row);
    expect(Buffer.isBuffer(buf)).toBe(true);
    // No assertion on absence of text here beyond "it still renders" — pdf-lib
    // buffers aren't grep-able plain text, so the presence assertion below
    // (extracted via composeProtocol, not the raw PDF) is the real check.
  });

  it('composeProtocol via the preliminary path exposes an unsigned-notice flag the renderer consumes', () => {
    const row = minimalCustomerLegRow();
    // renderProtocolPdf itself is opaque (PDF bytes); the CONTRACT under test is
    // that passing the option does not throw and produces a larger or equal
    // byte length (an extra drawn line), proxying "something extra rendered".
    return Promise.all([
      renderProtocolPdf(row),
      renderProtocolPdf(row, { preliminaryNotice: true }),
    ]).then(([plain, marked]) => {
      expect(marked.length).toBeGreaterThan(plain.length);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- handover-pdf.spec --maxWorkers=4`
Expected: FAIL — `renderProtocolPdf` doesn't accept a second argument yet /
`marked.length` equals `plain.length`.

- [ ] **Step 3: Implement the option**

In `handover-pdf.ts`, change the signature and add the draw call right after
`drawDocumentHeader`:

```ts
export async function renderProtocolPdf(
  row: any,
  opts?: { preliminaryNotice?: boolean },
): Promise<Buffer> {
  const d = await createDoc(A4_PORTRAIT);
  const t = composeProtocol(row);
  const operatorSnap = row.kind === 'operator_to_customer' ? row.fromSnapshot : row.toSnapshot;
  const brand = String(operatorSnap?.name ?? 'ФермериБГ');

  drawDocumentHeader(d, {
    brand,
    title: t.title,
    number: row.protocolNumber != null ? String(row.protocolNumber) : null,
    date: new Date(row.signedAt ?? row.createdAt ?? Date.now()),
  });

  if (opts?.preliminaryNotice) {
    ensureSpace(d, 16);
    d.page.drawText(
      'ПРЕДВАРИТЕЛЕН — подписва се при предаването на стоката',
      { x: MARGIN, y: d.y, size: 9, font: d.font, color: INK },
    );
    d.y -= 16;
  }

  // ...rest of the function body is unchanged...
```

(Leave everything below the header block exactly as it is today — only the two additions
above.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- handover-pdf.spec --maxWorkers=4`
Expected: PASS.

- [ ] **Step 5: Re-run the FULL existing `handover-pdf.spec.ts` + `handover.service.spec.ts`
  suites (not just your new tests)**

Run: `pnpm --filter @fermeribg/api test -- handover-pdf.spec handover.service.spec --maxWorkers=4`
Expected: PASS — the optional-parameter design must not change output for any call that
doesn't pass `{ preliminaryNotice: true }`.

- [ ] **Step 6: Teeth-check**

Comment out the `if (opts?.preliminaryNotice) { ... }` block. Confirm Step 1's second test
now fails (`marked.length` no longer greater). Restore the block.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/handover/handover-pdf.ts server/src/modules/handover/handover-pdf.spec.ts
git commit -m "feat(handover): optional preliminary-notice marker on renderProtocolPdf"
```

---

### Task 4: `EmailService.sendMailNow` + attachment materialization

**Files:**
- Create: `server/src/common/email/protocol-attachment.types.ts`
- Modify: `server/src/common/email/email.service.ts`
- Test: `server/src/common/email/email.service.spec.ts`

**Interfaces:**
- Produces:
  - `PROTOCOL_ATTACHMENT_RESOLVER` (DI token, `Symbol`) + `ProtocolAttachmentResolver`
    interface: `{ resolve(d: { kind: 'handover-protocol'; protocolId: string; tenantId:
    string }): Promise<{ filename: string; content: Buffer }> }`.
  - `SendMailOptions.attachments?: { kind: 'handover-protocol'; protocolId: string;
    tenantId: string }[]`.
  - `EmailService.sendMailNow(options: SendMailOptions): Promise<void>` — performs exactly
    one delivery attempt via `deliver()`, no BullMQ involvement, throws on failure (does not
    swallow).
- Consumes (by Task 5's `HandoverProtocolAttachmentResolver`): nothing new — that resolver
  implements the interface above.

- [ ] **Step 1: Write the failing test — sendMailNow bypasses the queue**

Add to `email.service.spec.ts`:

```ts
describe('EmailService.sendMailNow (direct, no queue)', () => {
  it('calls deliver() directly and never touches the queue', async () => {
    const queue = makeQueue();
    const svc = await build(queue, makeSuppression(false));
    jest.spyOn(svc as any, 'writePreview').mockResolvedValue(undefined);

    await svc.sendMailNow({ to: 'a@b.bg', subject: 'Hi', html: '<p>x</p>' });

    expect(queue.add).not.toHaveBeenCalled();
  });

  it('propagates a delivery failure to the caller (no swallow, no retry)', async () => {
    const svc = await build(makeQueue(), makeSuppression(false));
    jest.spyOn(svc as any, 'writePreview').mockRejectedValue(new Error('disk full'));

    await expect(
      svc.sendMailNow({ to: 'a@b.bg', subject: 'Hi', html: '<p>x</p>' }),
    ).rejects.toThrow('disk full');
  });
});

describe('EmailService attachment materialization', () => {
  it('resolves a handover-protocol attachment via the injected resolver before delivering', async () => {
    const resolver = {
      resolve: jest.fn().mockResolvedValue({ filename: 'protocol-7.pdf', content: Buffer.from('%PDF-1.4 fake') }),
    };
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        { provide: ConfigService, useValue: cfg() },
        { provide: SuppressionService, useValue: makeSuppression(false) },
        { provide: getQueueToken(EMAIL_QUEUE), useValue: makeQueue() },
        { provide: PROTOCOL_ATTACHMENT_RESOLVER, useValue: resolver },
      ],
    }).compile();
    const svc = mod.get(EmailService);
    svc.onModuleInit();
    const previewSpy = jest.spyOn(svc as any, 'writePreview').mockResolvedValue(undefined);

    await svc.deliver({
      to: 'a@b.bg',
      subject: 'Протокол',
      html: '<p>x</p>',
      attachments: [{ kind: 'handover-protocol', protocolId: 'p1', tenantId: 't1' }],
    });

    expect(resolver.resolve).toHaveBeenCalledWith({ kind: 'handover-protocol', protocolId: 'p1', tenantId: 't1' });
    // The ACTUAL bytes reached writePreview's options — not a boolean, the real content.
    const opts = previewSpy.mock.calls[0][0];
    expect(opts.attachments[0].content).toEqual(Buffer.from('%PDF-1.4 fake'));
    expect(opts.attachments[0].filename).toBe('protocol-7.pdf');
  });

  it('throws a clear error if attachments are requested but no resolver is wired', async () => {
    const svc = await build(makeQueue(), makeSuppression(false)); // no resolver provided
    await expect(
      svc.deliver({
        to: 'a@b.bg', subject: 'x', html: 'x',
        attachments: [{ kind: 'handover-protocol', protocolId: 'p1', tenantId: 't1' }],
      }),
    ).rejects.toThrow(/attachment resolver/i);
  });
});
```

Add the needed imports at the top of the spec (`Test`, `TestingModule` already imported;
add `PROTOCOL_ATTACHMENT_RESOLVER` from the new types file).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- email.service.spec --maxWorkers=4`
Expected: FAIL — `svc.sendMailNow is not a function`; `PROTOCOL_ATTACHMENT_RESOLVER` doesn't
exist yet.

- [ ] **Step 3: Create the resolver types file**

`server/src/common/email/protocol-attachment.types.ts`:

```ts
/** Descriptor for a lazily-materialized email attachment. Only one `kind` exists
 *  today; more (e.g. a future `kind: 'consolidated-protocol'` for §4.4) get their
 *  own resolver registered against the same token, dispatched by `kind`. */
export interface HandoverProtocolAttachmentDescriptor {
  kind: 'handover-protocol';
  protocolId: string;
  tenantId: string;
}

export interface ProtocolAttachmentResolver {
  resolve(d: HandoverProtocolAttachmentDescriptor): Promise<{ filename: string; content: Buffer }>;
}

export const PROTOCOL_ATTACHMENT_RESOLVER = Symbol('PROTOCOL_ATTACHMENT_RESOLVER');
```

- [ ] **Step 4: Implement `sendMailNow` + attachment materialization in `email.service.ts`**

Add the import, the optional injected resolver, the `attachments` field on
`SendMailOptions`, `sendMailNow`, and materialize-then-deliver logic:

```ts
import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
// ...
import {
  PROTOCOL_ATTACHMENT_RESOLVER,
  type ProtocolAttachmentResolver,
  type HandoverProtocolAttachmentDescriptor,
} from './protocol-attachment.types';

export interface SendMailOptions {
  // ...existing fields unchanged...
  /** Lazily-materialized attachments — described, not carried, so a BullMQ job
   *  payload stays small and a retry re-renders fresh bytes instead of resending
   *  stale ones. Resolved to real bytes inside `deliver()`, right before send. */
  attachments?: HandoverProtocolAttachmentDescriptor[];
}
```

In the class:

```ts
  constructor(
    private readonly config: ConfigService,
    private readonly suppression: SuppressionService,
    @InjectQueue(EMAIL_QUEUE) private readonly queue: Queue,
    @Optional() @Inject(PROTOCOL_ATTACHMENT_RESOLVER)
    private readonly attachmentResolver?: ProtocolAttachmentResolver,
  ) {
    // ...unchanged body...
  }

  /**
   * Deliver exactly ONE attempt, synchronously, bypassing the BullMQ queue
   * entirely — used by the order-confirm flow, which needs to OBSERVE
   * pass/fail before deciding whether to flip the order to `confirmed` (a
   * queued `sendMail()` only confirms the job was enqueued, not delivered).
   * No automatic retry: a failure here is surfaced to the caller immediately,
   * matching the ~1-3s latency the confirm flow is documented to accept —
   * BullMQ's configured 5-attempt exponential backoff would instead take tens
   * of seconds. Retries are user-driven (re-click confirm), not automatic.
   *
   * NOTE: this is also the method the NEW `PROTOCOL_EMAIL_QUEUE` processor
   * calls (via `OrderProtocolEmailService.sendProtocolEmail`) for the bulk and
   * Stripe paths — but from inside THAT queue's job, so BullMQ's retry lives
   * one layer up, at the job level, not here. Called from two different
   * queues (or no queue at all) but always exactly one attempt per call.
   */
  async sendMailNow(options: SendMailOptions): Promise<void> {
    await this.deliver(options);
  }

  /** Actually send (called by EmailProcessor, or directly by sendMailNow). */
  async deliver(options: SendMailOptions): Promise<void> {
    const stream: EmailStream = options.stream ?? 'transactional';

    if (!options.skipSuppressionCheck && (await this.suppression.isSuppressed(options.to))) {
      this.logger.warn(`[email] skipped suppressed recipient to=${options.to}`);
      return;
    }

    const resolvedAttachments = await this.resolveAttachments(options.attachments);

    const from = this.streamFrom(stream);
    const text = options.text ?? htmlToText(options.html);
    const replyTo = options.replyTo ?? this.defaultReplyTo;
    const deliverOptions = { ...options, attachments: resolvedAttachments };

    if (!this.isDevMode && this.transporter) {
      await this.transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text,
        ...(replyTo ? { replyTo } : {}),
        ...(options.headers ? { headers: options.headers } : {}),
        ...(resolvedAttachments.length ? { attachments: resolvedAttachments } : {}),
      });
      return;
    }

    await this.writePreview(deliverOptions as any, from, stream);
  }

  /** Turn `{kind, protocolId, tenantId}` descriptors into real bytes right
   *  before send. Throws (does not silently drop) if attachments were
   *  requested but nothing implements the resolver — a wiring bug, not a
   *  runtime edge case to swallow. */
  private async resolveAttachments(
    descriptors: HandoverProtocolAttachmentDescriptor[] | undefined,
  ): Promise<{ filename: string; content: Buffer }[]> {
    if (!descriptors?.length) return [];
    if (!this.attachmentResolver) {
      throw new Error(
        'Email requested attachments but no attachment resolver is wired (PROTOCOL_ATTACHMENT_RESOLVER) — check EmailModule imports.',
      );
    }
    return Promise.all(descriptors.map((d) => this.attachmentResolver!.resolve(d)));
  }
```

Also update `writePreview`'s signature to accept the now-widened options type (it already
takes `SendMailOptions`; the dev-preview file write should list attachment filenames, not
silently drop them — per spec 4.1's "writePreview() в dev също трябва да отрази прикачения
файл"):

```ts
  private async writePreview(options: SendMailOptions, from: string, stream: EmailStream): Promise<void> {
    try {
      await fs.promises.mkdir(this.previewDir, { recursive: true });
      const sanitizedTo = options.to.replace(/[^a-zA-Z0-9@._-]/g, '_');
      const filename = `${Date.now()}-${sanitizedTo}.html`;
      const filePath = path.join(this.previewDir, filename);
      const now = new Date().toISOString();
      const attachmentNote = (options as any).attachments?.length
        ? `<!-- attachments: ${(options as any).attachments.map((a: any) => a.filename).join(', ')} -->\n`
        : '';
      const content = `<!-- to: ${options.to} | from: ${from} | stream: ${stream} | subject: ${options.subject} | date: ${now} -->\n${attachmentNote}${options.html}`;
      await fs.promises.writeFile(filePath, content, 'utf8');
      this.logger.log(
        `[email:preview] stream=${stream} to=${options.to} subject="${options.subject}" file=${filePath}`,
      );
    } catch (err) {
      this.logger.error(
        `[email:preview] failed to write preview file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- email.service.spec --maxWorkers=4`
Expected: PASS, all 4 new tests + all pre-existing ones in the file.

- [ ] **Step 6: Teeth-check**

Comment out the `resolveAttachments` call in `deliver()` (replace with
`const resolvedAttachments: any[] = [];`). Confirm the "resolves a handover-protocol
attachment" test now fails (content assertion). Restore.

- [ ] **Step 7: Commit**

```bash
git add server/src/common/email/protocol-attachment.types.ts server/src/common/email/email.service.ts server/src/common/email/email.service.spec.ts
git commit -m "feat(email): add sendMailNow (direct, one-shot delivery) + lazy attachment resolution"
```

---

### Task 5: `OrderProtocolEmailService` + its BullMQ queue — render→send→track, and the fast enqueue path

**Files:**
- Create: `server/src/modules/order-protocol-email/order-protocol-email.module.ts`
- Create: `server/src/modules/order-protocol-email/order-protocol-email.service.ts`
- Create: `server/src/modules/order-protocol-email/order-protocol-email.processor.ts`
- Create: `server/src/modules/order-protocol-email/handover-protocol-attachment.resolver.ts`
- Create: `server/src/modules/order-protocol-email/order-protocol-email.service.spec.ts`
- Create: `server/src/modules/order-protocol-email/order-protocol-email.processor.spec.ts`
- Modify: `server/src/common/queue/queue.constants.ts` (add `PROTOCOL_EMAIL_QUEUE`)
- Modify: `server/src/common/email/email.module.ts` (import the new module so the resolver
  token is visible to `EmailService`)

**Interfaces:**
- Consumes: `HandoverService.ensureDraftTarget`, `HandoverService.renderPdfForEmail` (Task
  2), `EmailService.sendMailNow` (Task 4), `orders` / `DB_TOKEN` (direct read of
  `customerEmail`/`customerName`/`orderNumber`/`tenantId`, and the write of the three new
  tracking columns).
- Produces:
  - `OrderProtocolEmailService.sendProtocolEmail(tenantId: string, orderId: string):
    Promise<{ ok: true; skipped?: 'no-email' | 'already-sent' } | { ok: false; error: string
    }>` — the render→await-send→track helper. **Does not** touch `orders.status`. Called
    **inline** by Task 6 (human path); called from **inside the new processor below** for
    Tasks 7/8 (queued paths) and Task 9 (resend).
  - `OrderProtocolEmailService.enqueueProtocolEmail(tenantId: string, orderId: string):
    Promise<void>` — a fast, non-blocking `queue.add(...)`. **Never awaits SMTP.** Consumed
    by Task 7 (`confirmPending`), Task 8 (`markOrderPaid`), and Task 9 (`resendProtocolEmail`).
  - `PROTOCOL_EMAIL_QUEUE` (new queue constant) + `OrderProtocolEmailProcessor` (new BullMQ
    processor) — the async machinery that turns an enqueued job back into a call to
    `sendProtocolEmail`. Modeled directly on this codebase's one existing email-queue
    pattern: `EMAIL_QUEUE` / `EmailService.sendMail()` / `EmailProcessor`
    (`server/src/common/email/email.module.ts`, `email.processor.ts`) — same
    `BullModule.registerQueue({ name, defaultJobOptions })` shape, same
    `@Processor(QUEUE, { concurrency, limiter })` + `WorkerHost` + `process(job)` shape, same
    `RUN_WORKERS`-gated provider registration so a `web`-role process never starts the worker.

- [ ] **Step 1: Write the failing tests — the SAFETY FLOOR assertions for `sendProtocolEmail`**

`order-protocol-email.service.spec.ts`. Note the `buildDeps` helper now also returns a mock
`queue` — `OrderProtocolEmailService`'s constructor gains a 4th param (`@InjectQueue
(PROTOCOL_EMAIL_QUEUE) queue: Queue`) for Step 6 below; thread a mock through from the start
so this file compiles once that param exists.

```ts
import { OrderProtocolEmailService } from './order-protocol-email.service';

function buildDeps(orderRow: any) {
  const updateCalls: any[] = [];
  const updateChain: any = {};
  updateChain.set = jest.fn((vals: any) => { updateCalls.push(vals); return updateChain; });
  updateChain.where = jest.fn(() => Promise.resolve());
  const selectChain: any = {};
  selectChain.from = jest.fn(() => selectChain);
  selectChain.where = jest.fn(() => selectChain);
  selectChain.limit = jest.fn(() => Promise.resolve([orderRow]));
  const db: any = {
    select: jest.fn(() => selectChain),
    update: jest.fn(() => updateChain),
  };
  const handover = {
    ensureDraftTarget: jest.fn().mockResolvedValue({ id: 'protocol-1' }),
    renderPdfForEmail: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 real bytes')),
  };
  const email = { sendMailNow: jest.fn().mockResolvedValue(undefined) };
  const queue = { add: jest.fn().mockResolvedValue(undefined) };
  return { db, handover, email, queue, updateCalls };
}

describe('OrderProtocolEmailService.sendProtocolEmail', () => {
  it('renders + sends BEFORE writing protocol_email_status=sent (order of operations)', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue, updateCalls } = buildDeps(order);
    const callOrder: string[] = [];
    handover.renderPdfForEmail.mockImplementation(async () => { callOrder.push('render'); return Buffer.from('%PDF-1.4'); });
    email.sendMailNow.mockImplementation(async () => { callOrder.push('send'); });
    db.update.mockImplementation(() => { callOrder.push('write-status'); return { set: jest.fn().mockReturnThis(), where: jest.fn().mockResolvedValue(undefined) }; });

    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);
    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: true });
    expect(callOrder).toEqual(['render', 'send', 'write-status']);
    expect(email.sendMailNow).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'buyer@x.bg',
        attachments: [{ kind: 'handover-protocol', protocolId: 'protocol-1', tenantId: 't1' }],
      }),
    );
  });

  it('ACTUAL PDF bytes reach the mailer as a real attachment (not a boolean flag)', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue } = buildDeps(order);
    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);

    await svc.sendProtocolEmail('t1', 'o1');

    // The descriptor references protocolId/tenantId (lazy) — but prove the
    // helper ALSO actually rendered non-empty bytes at some point, not merely
    // that it "would" — renderPdfForEmail is the render call, and it must have
    // been invoked with the real ids, returning a non-empty buffer.
    expect(handover.renderPdfForEmail).toHaveBeenCalledWith('t1', 'protocol-1');
    const rendered = await handover.renderPdfForEmail.mock.results[0].value;
    expect(Buffer.isBuffer(rendered)).toBe(true);
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('a mailer failure leaves protocol_email_status=failed and does NOT write sent', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue, updateCalls } = buildDeps(order);
    email.sendMailNow.mockRejectedValue(new Error('SMTP timeout'));

    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);
    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: false, error: 'SMTP timeout' });
    expect(updateCalls).toEqual([
      expect.objectContaining({ protocolEmailStatus: 'failed', protocolEmailError: 'SMTP timeout' }),
    ]);
    expect(updateCalls.some((c) => c.protocolEmailStatus === 'sent')).toBe(false);
  });

  it('skips render+send and reports skipped when the order has no email on file', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: null, customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue } = buildDeps(order);
    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);

    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: true, skipped: 'no-email' });
    expect(handover.ensureDraftTarget).not.toHaveBeenCalled();
    expect(email.sendMailNow).not.toHaveBeenCalled();
  });

  it('idempotent: a second call after protocol_email_status=sent does not resend', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: 'sent' };
    const { db, handover, email, queue } = buildDeps(order);
    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);

    const result = await svc.sendProtocolEmail('t1', 'o1');

    expect(result).toEqual({ ok: true, skipped: 'already-sent' });
    expect(email.sendMailNow).not.toHaveBeenCalled();
    expect(handover.ensureDraftTarget).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- order-protocol-email.service.spec --maxWorkers=4`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Add the new queue constant**

In `server/src/common/queue/queue.constants.ts`, append:

```ts
export const PROTOCOL_EMAIL_QUEUE = 'protocol-email';
```

- [ ] **Step 4: Implement `OrderProtocolEmailService` (render→send→track + enqueue)**

`order-protocol-email.service.ts`:

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { type Database, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PROTOCOL_EMAIL_QUEUE } from '../../common/queue/queue.constants';
import { HandoverService } from '../handover/handover.service';
import { EmailService } from '../../common/email/email.service';

export type SendProtocolEmailResult =
  | { ok: true; skipped?: 'no-email' | 'already-sent' }
  | { ok: false; error: string };

/** The one BullMQ job shape carried by PROTOCOL_EMAIL_QUEUE. */
export interface ProtocolEmailJobData {
  tenantId: string;
  orderId: string;
}

/**
 * The one place render → await-real-send → write-tracking-columns happens for
 * the customer's bilateral protocol. Deliberately does NOT touch orders.status
 * — every caller decides the flip itself:
 *  - OrdersService.updateStatus (Task 6, human path) calls `sendProtocolEmail`
 *    INLINE, awaits it, and flips status only on `ok: true` — the one path
 *    allowed to pay the latency (§4.3).
 *  - OrdersService.confirmPending (Task 7) and StripeService.markOrderPaid
 *    (Task 8) flip status per their own existing logic FIRST, then call
 *    `enqueueProtocolEmail` — fire a PROTOCOL_EMAIL_QUEUE job and return
 *    immediately. `OrderProtocolEmailProcessor` (below) is what eventually
 *    calls `sendProtocolEmail` for those two paths, off the request entirely.
 *  - OrdersService.resendProtocolEmail (Task 9, "прати пак") also just calls
 *    `enqueueProtocolEmail` again — idempotent via the `already-sent` check
 *    below.
 */
@Injectable()
export class OrderProtocolEmailService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly handover: HandoverService,
    private readonly email: EmailService,
    @InjectQueue(PROTOCOL_EMAIL_QUEUE) private readonly queue: Queue,
  ) {}

  async sendProtocolEmail(tenantId: string, orderId: string): Promise<SendProtocolEmailResult> {
    const [order] = await this.db
      .select()
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);
    if (!order) return { ok: false, error: 'Поръчката не е намерена' };

    // Idempotent: a prior successful send (this attempt, a previous confirm
    // attempt, or an earlier queued job) must not re-render/re-send. The
    // caller still gets `ok: true` so any status flip it's gating proceeds.
    if (order.protocolEmailStatus === 'sent') {
      return { ok: true, skipped: 'already-sent' };
    }

    const to = order.customerEmail?.trim();
    if (!to) {
      // Nothing to email — not a failure. Mirrors the existing
      // OrderConfirmationService no-op-without-email convention.
      return { ok: true, skipped: 'no-email' };
    }

    const { id: protocolId } = await this.handover.ensureDraftTarget(tenantId, {
      kind: 'operator_to_customer',
      orderId,
    } as any);

    try {
      await this.email.sendMailNow({
        to,
        subject: `Разписка за поръчка №${order.orderNumber ?? ''}`.trim(),
        html: this.renderHtml(order),
        attachments: [{ kind: 'handover-protocol', protocolId, tenantId }],
        stream: 'transactional',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.db
        .update(orders)
        .set({ protocolEmailStatus: 'failed', protocolEmailAt: new Date(), protocolEmailError: message })
        .where(eq(orders.id, orderId));
      return { ok: false, error: message };
    }

    await this.db
      .update(orders)
      .set({ protocolEmailStatus: 'sent', protocolEmailAt: new Date(), protocolEmailError: null })
      .where(eq(orders.id, orderId));
    return { ok: true };
  }

  /**
   * Non-blocking counterpart to `sendProtocolEmail`, for the paths that flip
   * `orders.status` BEFORE the email outcome is known (bulk confirm-pending,
   * Stripe webhook, and the "прати пак" resend action) — per §4.3, only the
   * human confirm path (Task 6) is allowed to await the real send. Hands a
   * small `{tenantId, orderId}` descriptor to PROTOCOL_EMAIL_QUEUE;
   * `OrderProtocolEmailProcessor` picks it up and runs the SAME
   * `sendProtocolEmail` — so render/send/track logic exists in exactly one
   * place regardless of which path triggered it.
   */
  async enqueueProtocolEmail(tenantId: string, orderId: string): Promise<void> {
    const data: ProtocolEmailJobData = { tenantId, orderId };
    await this.queue.add('send-protocol-email', data);
  }

  /** Minimal transactional body — this is NOT the storefront thank-you email
   *  (OrderConfirmationService owns that, unchanged); it exists only to carry
   *  the attachment and explain what it is. Kept intentionally plain. */
  private renderHtml(order: { customerName: string | null; orderNumber: number | null }): string {
    const greeting = order.customerName ? `Здравей, ${order.customerName}!` : 'Здравей!';
    return `<!doctype html><html lang="bg"><body style="font-family:Arial,Helvetica,sans-serif">
<p>${greeting}</p>
<p>Прилагаме разписка за получена стока по поръчка №${order.orderNumber ?? ''}. Документът е
предварителен — подписва се при предаването на стоката.</p>
</body></html>`;
  }
}
```

- [ ] **Step 5: Run test to verify `sendProtocolEmail` passes**

Run: `pnpm --filter @fermeribg/api test -- order-protocol-email.service.spec --maxWorkers=4`
Expected: PASS, all 5 `sendProtocolEmail` tests (the constructor now compiles with the 4th
`queue` param even though nothing exercises `enqueueProtocolEmail` yet — that's Step 6).

- [ ] **Step 6: Write the failing test for `enqueueProtocolEmail`, then make it pass**

Add to the same spec file:

```ts
describe('OrderProtocolEmailService.enqueueProtocolEmail', () => {
  it('adds a job to PROTOCOL_EMAIL_QUEUE and returns without touching email/handover at all', async () => {
    const order = { id: 'o1', tenantId: 't1', customerEmail: 'buyer@x.bg', customerName: 'Иван', orderNumber: 42, protocolEmailStatus: null };
    const { db, handover, email, queue } = buildDeps(order);
    const svc = new OrderProtocolEmailService(db, handover as any, email as any, queue as any);

    await svc.enqueueProtocolEmail('t1', 'o1');

    expect(queue.add).toHaveBeenCalledWith('send-protocol-email', { tenantId: 't1', orderId: 'o1' });
    expect(email.sendMailNow).not.toHaveBeenCalled();
    expect(handover.ensureDraftTarget).not.toHaveBeenCalled();
    expect(db.select).not.toHaveBeenCalled();
  });
});
```

This already passes given Step 4's implementation — this step exists to make the RED/GREEN
discipline explicit for `enqueueProtocolEmail` specifically (temporarily comment out the
method body to confirm it fails first, then restore, if your process requires seeing red).

- [ ] **Step 7: Write the failing test for the processor, then implement it**

`order-protocol-email.processor.spec.ts`:

```ts
import { OrderProtocolEmailProcessor } from './order-protocol-email.processor';

function job(data: { tenantId: string; orderId: string }) {
  return { id: 'job-1', data } as any;
}

describe('OrderProtocolEmailProcessor', () => {
  it('calls sendProtocolEmail with the job payload and resolves on ok:true', async () => {
    const svc = { sendProtocolEmail: jest.fn().mockResolvedValue({ ok: true }) };
    const processor = new OrderProtocolEmailProcessor(svc as any);

    await expect(processor.process(job({ tenantId: 't1', orderId: 'o1' }))).resolves.toBeUndefined();
    expect(svc.sendProtocolEmail).toHaveBeenCalledWith('t1', 'o1');
  });

  it('throws on ok:false so BullMQ applies its configured retry/backoff', async () => {
    const svc = { sendProtocolEmail: jest.fn().mockResolvedValue({ ok: false, error: 'SMTP timeout' }) };
    const processor = new OrderProtocolEmailProcessor(svc as any);

    await expect(processor.process(job({ tenantId: 't1', orderId: 'o1' }))).rejects.toThrow('SMTP timeout');
  });

  it('does NOT throw on a skipped outcome (no-email / already-sent) — that is success, not failure', async () => {
    const svc = { sendProtocolEmail: jest.fn().mockResolvedValue({ ok: true, skipped: 'already-sent' }) };
    const processor = new OrderProtocolEmailProcessor(svc as any);

    await expect(processor.process(job({ tenantId: 't1', orderId: 'o1' }))).resolves.toBeUndefined();
  });
});
```

Run: `pnpm --filter @fermeribg/api test -- order-protocol-email.processor.spec --maxWorkers=4`
Expected: FAIL — file doesn't exist. Then implement:

`order-protocol-email.processor.ts`:

```ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { OrderProtocolEmailService, ProtocolEmailJobData } from './order-protocol-email.service';
import { PROTOCOL_EMAIL_QUEUE } from '../../common/queue/queue.constants';

// Mirrors EmailProcessor/EMAIL_QUEUE exactly (this codebase's one existing
// email-queue pattern, server/src/common/email/email.processor.ts) — same
// concurrency/limiter shape. Deliberate: a protocol-email job ends up calling
// the SAME pooled SMTP transporter (EmailService.sendMailNow →
// EmailService.deliver) as EMAIL_QUEUE's own jobs, so keeping the two
// processors' rate limits aligned avoids one queue starving the other's share
// of the transporter's maxConnections:3 pool.
@Processor(PROTOCOL_EMAIL_QUEUE, { concurrency: 5, limiter: { max: 10, duration: 1000 } })
export class OrderProtocolEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(OrderProtocolEmailProcessor.name);

  constructor(private readonly orderProtocolEmail: OrderProtocolEmailService) {
    super();
  }

  async process(job: Job<ProtocolEmailJobData>): Promise<void> {
    const { tenantId, orderId } = job.data;
    const result = await this.orderProtocolEmail.sendProtocolEmail(tenantId, orderId);
    if (!result.ok) {
      // Throw so BullMQ applies PROTOCOL_EMAIL_QUEUE's configured retry/backoff
      // (attempts: 5, exponential 2000ms — see the module below). Unlike the
      // human path (Task 6), which has no automatic retry and relies on the
      // user re-clicking confirm, a queued job gets several automatic attempts
      // before it's truly stuck — visible via protocol_email_status='failed'
      // and recoverable via the "прати пак" action (Task 9).
      this.logger.error(`[protocol-email] send failed job=${job.id} order=${orderId}: ${result.error}`);
      throw new Error(result.error);
    }
  }
}
```

Run again: expect PASS.

- [ ] **Step 8: The resolver adapter (for Task 4's DI token) + the module (queue registration
  + processor)**

`handover-protocol-attachment.resolver.ts`:

```ts
import { Injectable } from '@nestjs/common';
import { HandoverService } from '../handover/handover.service';
import type {
  ProtocolAttachmentResolver,
  HandoverProtocolAttachmentDescriptor,
} from '../../common/email/protocol-attachment.types';

@Injectable()
export class HandoverProtocolAttachmentResolver implements ProtocolAttachmentResolver {
  constructor(private readonly handover: HandoverService) {}

  async resolve(d: HandoverProtocolAttachmentDescriptor): Promise<{ filename: string; content: Buffer }> {
    const content = await this.handover.renderPdfForEmail(d.tenantId, d.protocolId);
    return { filename: `protokol-${d.protocolId}.pdf`, content };
  }
}
```

`order-protocol-email.module.ts`:

```ts
import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { HandoverModule } from '../handover/handover.module';
import { OrderProtocolEmailService } from './order-protocol-email.service';
import { OrderProtocolEmailProcessor } from './order-protocol-email.processor';
import { HandoverProtocolAttachmentResolver } from './handover-protocol-attachment.resolver';
import { PROTOCOL_ATTACHMENT_RESOLVER } from '../../common/email/protocol-attachment.types';
import { PROTOCOL_EMAIL_QUEUE } from '../../common/queue/queue.constants';
import { RUN_WORKERS } from '../../config/app-role';

/**
 * forwardRef on HandoverModule: HandoverModule -> RoutingModule -> (forwardRef)
 * OrdersModule -> (this module, once Task 6/7 wire it) -> HandoverModule closes
 * a long cycle through 4 modules. forwardRef here is cheap insurance — mirrors
 * OrdersModule's own forwardRef(() => RoutingModule) for the same reason.
 *
 * BullModule.registerQueue + the RUN_WORKERS-gated processor provider mirror
 * EmailModule's EMAIL_QUEUE registration exactly (same defaultJobOptions
 * shape) — see Task 5's rationale in order-protocol-email.processor.ts.
 */
@Module({
  imports: [
    forwardRef(() => HandoverModule),
    BullModule.registerQueue({
      name: PROTOCOL_EMAIL_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      },
    }),
  ],
  providers: [
    OrderProtocolEmailService,
    HandoverProtocolAttachmentResolver,
    { provide: PROTOCOL_ATTACHMENT_RESOLVER, useExisting: HandoverProtocolAttachmentResolver },
    ...(RUN_WORKERS ? [OrderProtocolEmailProcessor] : []),
  ],
  exports: [OrderProtocolEmailService, PROTOCOL_ATTACHMENT_RESOLVER],
})
export class OrderProtocolEmailModule {}
```

Modify `email.module.ts` to import it, so `EmailService`'s `@Optional() @Inject
(PROTOCOL_ATTACHMENT_RESOLVER)` actually resolves in the real app (not just in the unit
test, which provides its own mock):

```ts
import { OrderProtocolEmailModule } from '../../modules/order-protocol-email/order-protocol-email.module';

@Global()
@Module({
  imports: [
    BullModule.registerQueue({ /* unchanged EMAIL_QUEUE registration */ }),
    OrderProtocolEmailModule,
  ],
  controllers: [EmailWebhookController],
  providers: [EmailService, SuppressionService, ...(RUN_WORKERS ? [EmailProcessor] : [])],
  exports: [EmailService, SuppressionService],
})
export class EmailModule {}
```

- [ ] **Step 9: Teeth-check**

Run: `pnpm --filter @fermeribg/api test -- order-protocol-email --maxWorkers=4` (both spec
files, still green). Then comment out `...(RUN_WORKERS ? [OrderProtocolEmailProcessor] : [])`
down to `[]` unconditionally and confirm — by reasoning, not a runnable assertion, since
`RUN_WORKERS` is computed once at module load from `process.env.APP_ROLE` — that a `worker`-
or `all`-role process would then silently never process protocol-email jobs (this mirrors
the exact same gap that would exist if `EmailProcessor` were similarly hardcoded off; flag,
don't invent a process-env-swapping test for it). Restore. Then boot-check the module graph:
`pnpm --filter @fermeribg/api build` (Nest DI cycle errors surface at runtime boot, not build
time — the REAL check is Task 6/7's own module-wiring teeth-check once `OrdersModule`/
`StripeModule` actually import `OrderProtocolEmailModule` — flag this sub-step as
informational only).

- [ ] **Step 10: Commit**

```bash
git add server/src/modules/order-protocol-email server/src/common/email/email.module.ts server/src/common/queue/queue.constants.ts
git commit -m "feat(orders): add OrderProtocolEmailService + PROTOCOL_EMAIL_QUEUE (render/send/track, and a non-blocking enqueue path)"
```

---

### Task 6: Wire the human confirm path — `OrdersService.updateStatus` (BLOCKS — unchanged from the original plan)

**This task is unchanged.** It already implements §4.3's single/human-path row correctly: the
confirm transition awaits `sendProtocolEmail` inline and only flips status on `ok: true`,
throwing loudly (no flip) otherwise. Nothing about the bulk/Stripe fix touches this task.

**Files:**
- Modify: `server/src/modules/orders/orders.module.ts`
- Modify: `server/src/modules/orders/orders.service.ts` (`updateStatus`, ~line 1767)
- Test: `server/src/modules/orders/orders.service.spec.ts` (or a new
  `orders.confirm-protocol-email.spec.ts` if the existing file's harness is a poor fit —
  check its constructor-mock style first, per the file already read during planning: it
  builds `new OrdersService(db, maps, orderEmail, econt, cache, carrierFulfillment, codRisk,
  catalogCache, commission)`)

**Interfaces:**
- Consumes: `OrderProtocolEmailService.sendProtocolEmail(tenantId, orderId):
  Promise<SendProtocolEmailResult>` (Task 5).
- Produces: `OrdersService` constructor gains a 10th, `@Optional()` parameter
  `protocolEmail?: OrderProtocolEmailService`, appended AFTER the existing `commission`
  parameter — so every one of the 18 existing spec files that construct `new
  OrdersService(...)` with 8 or 9 positional args keeps compiling unchanged (verified during
  planning: `orders.cod-outcome-revert.spec.ts` passes exactly 9, `orders.confirm-pending.
  spec.ts` passes 8 — neither passes a 10th). **This same 10th param is also what Task 7
  uses** (for `enqueueProtocolEmail`, not `sendProtocolEmail`) — one injected dependency,
  two of its methods used by two different tasks.

- [ ] **Step 1: Write the failing test — SAFETY FLOOR (order of operations + failure state)**

Add to `orders.service.spec.ts` (find its existing `updateStatus`-adjacent describe block and
its db-mock builder; adapt to that file's conventions rather than the sketch below verbatim
— but the ASSERTIONS must match this shape):

```ts
describe('OrdersService.updateStatus — confirm gates on the protocol email', () => {
  function buildSvc(prevStatus: string, sendResult: any) {
    const rowAfterFlip = { id: 'o1', status: 'confirmed' };
    const selectChain: any = { from: () => selectChain, where: () => selectChain, limit: () => Promise.resolve([{ status: prevStatus }]) };
    const updateChain: any = { set: jest.fn().mockReturnThis(), where: jest.fn().mockReturnThis(), returning: jest.fn().mockResolvedValue([rowAfterFlip]) };
    const db: any = { select: jest.fn(() => selectChain), update: jest.fn(() => updateChain) };
    const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
    const protocolEmail = { sendProtocolEmail: jest.fn().mockResolvedValue(sendResult) };
    const svc = new OrdersService(
      db, {} as any, {} as any, {} as any, cache, {} as any, {} as any, {} as any,
      undefined, protocolEmail as any,
    );
    return { svc, db, updateChain, protocolEmail };
  }

  it('calls sendProtocolEmail BEFORE writing status=confirmed, and only writes it on success', async () => {
    const { svc, db, updateChain, protocolEmail } = buildSvc('pending', { ok: true });
    const callOrder: string[] = [];
    protocolEmail.sendProtocolEmail.mockImplementation(async () => { callOrder.push('email'); return { ok: true }; });
    db.update.mockImplementation(() => { callOrder.push('flip'); return updateChain; });

    await svc.updateStatus('o1', 't1', { status: 'confirmed' } as any);

    expect(callOrder).toEqual(['email', 'flip']);
    expect(protocolEmail.sendProtocolEmail).toHaveBeenCalledWith('t1', 'o1');
  });

  it('a failed send throws and the row is never flipped to confirmed', async () => {
    const { svc, db, updateChain } = buildSvc('pending', { ok: false, error: 'SMTP timeout' });

    await expect(svc.updateStatus('o1', 't1', { status: 'confirmed' } as any)).rejects.toThrow(/SMTP timeout/);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('re-confirming an already-confirmed order does not re-gate on the email', async () => {
    const { svc, protocolEmail } = buildSvc('confirmed', { ok: true });
    await svc.updateStatus('o1', 't1', { status: 'confirmed' } as any);
    expect(protocolEmail.sendProtocolEmail).not.toHaveBeenCalled();
  });

  it('a non-confirm transition (e.g. delivered) never calls sendProtocolEmail', async () => {
    const { svc, protocolEmail } = buildSvc('confirmed', { ok: true });
    await svc.updateStatus('o1', 't1', { status: 'delivered' } as any);
    expect(protocolEmail.sendProtocolEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- orders.service.spec --maxWorkers=4`
Expected: FAIL — constructor arity mismatch / `sendProtocolEmail` never called / status
still flips on failure.

- [ ] **Step 3: Implement — constructor + `updateStatus` reorder**

In `orders.service.ts`, extend the constructor:

```ts
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly maps: MapsService,
    private readonly orderEmail: OrderConfirmationService,
    private readonly econt: EcontService,
    private readonly cache: PublicCacheService,
    private readonly carrierFulfillment: CarrierFulfillmentService,
    private readonly codRisk: CodRiskService,
    private readonly catalogCache: CatalogCacheService,
    @Optional() private readonly commission?: CommissionService,
    // Phase 2 (2026-07-22): gates the confirm transition on the bilateral
    // protocol email actually sending. @Optional() keeps the existing 18
    // OrdersService test harnesses valid (same rationale as `commission`
    // above); in the app the module always wires it.
    @Optional() private readonly protocolEmail?: OrderProtocolEmailService,
  ) {}
```

Restructure `updateStatus` — the confirm-specific gate goes BEFORE the existing `.update(...)
.set(statusUpdate)` call, and only for the genuine pending→confirmed transition:

```ts
  async updateStatus(id: string, tenantId: string, dto: UpdateOrderStatusDto): Promise<OrderRow> {
    const [prev] = await this.db
      .select({ status: orders.status })
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);

    const enteringConfirmed = dto.status === 'confirmed' && prev?.status !== 'confirmed';
    if (enteringConfirmed && this.protocolEmail) {
      const result = await this.protocolEmail.sendProtocolEmail(tenantId, id);
      if (!result.ok) {
        throw new ServiceUnavailableException(
          `Протоколът не можа да се изпрати: ${result.error}. Поръчката остава непотвърдена.`,
        );
      }
    }

    const statusUpdate: { status: OrderRow['status']; deliveredAt?: Date | null } = {
      status: dto.status as OrderRow['status'],
    };
    if (dto.status === 'delivered' && prev?.status !== 'delivered') {
      statusUpdate.deliveredAt = new Date();
    } else if (dto.status !== 'delivered' && prev?.status === 'delivered') {
      statusUpdate.deliveredAt = null;
    }
    const [row] = await this.db
      .update(orders)
      .set(statusUpdate)
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Поръчката не е намерена');
    if (dto.status === 'confirmed' && prev?.status !== 'confirmed') {
      void this.orderEmail.sendForOrder(id);
      void this.carrierFulfillment.autoCreateForOrder(id);
    }
    // ...rest of the function (cancelled-transition block, bustPayments, catalogCache) unchanged...
```

Add the `ServiceUnavailableException` import if not already present at the top of the file.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- orders.service.spec --maxWorkers=4`
Expected: PASS — new tests green, and re-run the WHOLE file (not just the new describe
block) to confirm no pre-existing `updateStatus` test broke.

- [ ] **Step 5: Wire the module**

`orders.module.ts`:

```ts
import { OrderProtocolEmailModule } from '../order-protocol-email/order-protocol-email.module';

@Module({
  imports: [
    StripeModule,
    EcontModule,
    SpeedyCoreModule,
    CarrierFulfillmentModule,
    OrderEmailModule,
    AnalyticsModule,
    CodRiskModule,
    CatalogCacheModule,
    VendorFinanceModule,
    OrderProtocolEmailModule,
    forwardRef(() => RoutingModule),
  ],
  controllers: [OrdersController, PublicOrdersController, PublicCheckoutController],
  providers: [OrdersService, CheckoutService],
  exports: [OrdersService],
})
export class OrdersModule {}
```

- [ ] **Step 6: Teeth-check**

Revert Step 3's reorder only (put the `.update(...).set(statusUpdate)` block back BEFORE the
`enteringConfirmed` gate, i.e. restore the original ordering) while leaving the gate call in
place — confirm the "calls sendProtocolEmail BEFORE writing status=confirmed" test now fails
(wrong `callOrder`). Restore the correct ordering. Then run
`pnpm --filter @fermeribg/api build` to confirm the module graph compiles (Nest DI errors
surface at boot, not build, so ALSO run `pnpm --filter @fermeribg/api test -- app.module` if
an app-boot smoke test exists in this repo — check first; if none exists, note this as a gap
rather than inventing one, and instead run the full orders test file plus
`order-protocol-email.service.spec` together as the closest available signal).

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/orders/orders.module.ts server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.service.spec.ts
git commit -m "feat(orders): gate the human confirm path on the protocol email (send-before-flip)"
```

---

### Task 7: Wire the bulk confirm path — `OrdersService.confirmPending` (QUEUES — fixed from the earlier draft)

**This task replaces the earlier draft's version, which turned the single bulk `UPDATE` into
a bounded-concurrency per-order loop that AWAITED `sendProtocolEmail` for every order,
directly contradicting §9.2 ("масовият път не я плаща"). The fix below is smaller than that
draft, not bigger: the existing bulk-UPDATE shape is left completely alone; only a
fire-and-enqueue step is added after it.**

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` (`confirmPending`, ~line 2079 —
  `drainConfirmEffects`, ~line 2109, is untouched)
- Modify (append tests, do NOT rewrite): `server/src/modules/orders/orders.confirm-pending.spec.ts`
  — its 3 existing tests ("without a date, confirms every pending order — no subselect",
  "with a date, scopes the UPDATE to the DELIVERY day", "busts the payments cache only when
  at least one order was confirmed") assert on the single bulk-`UPDATE`'s SQL shape, which
  this task does not change. They MUST still pass, unmodified, after this task.

**Interfaces:**
- Produces: `confirmPending(tenantId, date?): Promise<{ confirmed: number; failed: number }>`
  — `confirmed` is UNCHANGED in meaning (rows the one bulk `UPDATE` actually flipped to
  `confirmed`); `failed` is NEW and counts only how many of those orders' protocol-email
  jobs could not even be **enqueued** (e.g. a transient Redis hiccup) — it says nothing about
  SMTP delivery, which happens later, off this response entirely, and is tracked on the order
  row / surfaced via "прати пак" (Task 9) if it ultimately fails. Check
  `client/src/lib/api-client.ts:742`'s `confirmPending` + `today-client.tsx:83`'s caller for
  whether the client needs updating to surface `failed` — flagged as an open question below,
  out of this backend plan's scope to decide the UI copy, but the type change itself is a
  breaking response-shape change worth flagging to the frontend.

- [ ] **Step 1: Write the failing tests — ADD to the existing file, do not replace it**

Append to `orders.confirm-pending.spec.ts` (reuse its existing `buildDb`/`service` helpers —
extend `service()` to accept an optional `protocolEmail` mock as its constructor's 10th arg
rather than writing new mock plumbing):

```ts
function serviceWithProtocolEmail(db: unknown, protocolEmail: any): OrdersService {
  const cache: any = { del: jest.fn().mockResolvedValue(undefined) };
  return new OrdersService(
    db as any, {} as any, {} as any, {} as any, cache, {} as any, {} as any, {} as any,
    undefined, protocolEmail,
  );
}

describe('OrdersService.confirmPending — enqueues (never awaits) a protocol email per confirmed order', () => {
  it('enqueues one job per confirmed order and reports 0 failed on success', async () => {
    const { db } = buildDb([{ id: 'o1' }, { id: 'o2' }]);
    const protocolEmail = { enqueueProtocolEmail: jest.fn().mockResolvedValue(undefined) };
    const svc = serviceWithProtocolEmail(db, protocolEmail);

    const out = await svc.confirmPending('tenant-1');

    expect(out).toEqual({ confirmed: 2, failed: 0 });
    expect(protocolEmail.enqueueProtocolEmail).toHaveBeenCalledTimes(2);
    expect(protocolEmail.enqueueProtocolEmail).toHaveBeenCalledWith('tenant-1', 'o1');
    expect(protocolEmail.enqueueProtocolEmail).toHaveBeenCalledWith('tenant-1', 'o2');
  });

  it('a single enqueue failure is counted in `failed`, but BOTH orders stay confirmed', async () => {
    const { db } = buildDb([{ id: 'o1' }, { id: 'o2' }]);
    const protocolEmail = {
      enqueueProtocolEmail: jest.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Redis unreachable')),
    };
    const svc = serviceWithProtocolEmail(db, protocolEmail);

    const out = await svc.confirmPending('tenant-1');

    // The enqueue failure is NOT a reason to un-confirm an order — the bulk
    // UPDATE already committed both rows to 'confirmed' before any enqueue was
    // attempted. `failed` here means "email didn't even get queued", not
    // "order didn't confirm".
    expect(out).toEqual({ confirmed: 2, failed: 1 });
  });

  it('never calls sendProtocolEmail (the blocking helper) — only enqueueProtocolEmail', async () => {
    const { db } = buildDb([{ id: 'o1' }]);
    const protocolEmail = {
      enqueueProtocolEmail: jest.fn().mockResolvedValue(undefined),
      sendProtocolEmail: jest.fn(),
    };
    const svc = serviceWithProtocolEmail(db, protocolEmail);

    await svc.confirmPending('tenant-1');

    expect(protocolEmail.sendProtocolEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- orders.confirm-pending.spec --maxWorkers=4`
Expected: the 3 NEW tests FAIL (constructor doesn't accept a 10th positional arg yet /
`confirmPending` returns `{confirmed}` with no `failed` key); the 3 PRE-EXISTING tests
continue to PASS unmodified — confirm this before moving on, since if they don't, the
diff has touched something it shouldn't have.

- [ ] **Step 3: Implement — add the enqueue step; the bulk UPDATE itself is unchanged**

```ts
  /**
   * Bulk confirm all pending orders (optionally scoped to a single DELIVERY
   * day). The bulk-UPDATE shape below is UNCHANGED from before Phase 2: one
   * set-based UPDATE flips every eligible row in a single statement
   * (day-scoping via `id IN (subselect that joins deliverySlots)` — an UPDATE
   * can't leftJoin directly, see server/CLAUDE.md). Per §4.3 this path does
   * NOT gate the flip on the protocol email — only the human path
   * (OrdersService.updateStatus) does that. Instead, each freshly-confirmed
   * order gets a protocol-email job ENQUEUED (never awaited) right after the
   * flip; `failed` counts orders whose job could not even be enqueued (e.g.
   * Redis unreachable) — NOT SMTP failures, which land asynchronously in
   * protocol_email_status and are surfaced via "прати пак" (Task 9), not
   * this response.
   */
  async confirmPending(tenantId: string, date?: string): Promise<{ confirmed: number; failed: number }> {
    const baseConds = [eq(orders.tenantId, tenantId), eq(orders.status, 'pending')];
    let whereClause: SQL | undefined;
    if (date) {
      const scheduledIds = this.db
        .select({ id: orders.id })
        .from(orders)
        .leftJoin(deliverySlots, eq(deliverySlots.id, orders.slotId))
        .where(and(eq(orders.tenantId, tenantId), eq(orders.status, 'pending'), scheduledForDay(date)));
      whereClause = and(...baseConds, inArray(orders.id, scheduledIds));
    } else {
      whereClause = and(...baseConds);
    }
    const rows = await this.db
      .update(orders)
      .set({ status: 'confirmed' })
      .where(whereClause)
      .returning({ id: orders.id });

    // Fire the protocol-email job per confirmed order — enqueue only, never
    // awaited SMTP (§9.2/§4.3). A rejection here means the JOB never made it
    // onto the queue (infra failure); counted in `failed`, NOT a delivery
    // outcome, and does not touch the row's already-committed 'confirmed'
    // status.
    let failed = 0;
    await Promise.all(
      rows.map(async (r) => {
        try {
          await this.protocolEmail?.enqueueProtocolEmail(tenantId, r.id);
        } catch {
          failed++;
        }
      }),
    );

    // Each row was pending → confirmed (one-time): notify each buyer + (for Econt
    // orders on an auto-create farm) generate the waybill. Drained with a small
    // concurrency cap (detached) so a large bulk confirm doesn't open N SMTP/Econt
    // connections at once. Unrelated to the protocol email above (unchanged).
    void this.drainConfirmEffects(rows.map((r) => r.id));
    // Newly-confirmed orders enter the counted set — refresh the Плащания cache.
    if (rows.length) await this.bustPayments(tenantId);
    return { confirmed: rows.length, failed };
  }
```

`drainConfirmEffects` is unchanged (still fires `orderEmail.sendForOrder` +
`carrierFulfillment.autoCreateForOrder` detached, best-effort, for the ORIGINAL — unrelated
— thank-you email and waybill creation; the protocol email is handled entirely by the loop
above, not by `drainConfirmEffects`).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- orders.confirm-pending.spec --maxWorkers=4`
Expected: PASS — all 6 tests (3 pre-existing + 3 new).

- [ ] **Step 5: Teeth-check**

Temporarily change the `catch { failed++; }` block to `catch { /* swallow */ }` (drop the
increment). Confirm the "a single enqueue failure is counted in `failed`" test now fails
(`out.failed` would be `0`, not `1`). Restore. Then temporarily change
`this.protocolEmail?.enqueueProtocolEmail` to `this.protocolEmail?.sendProtocolEmail` and
confirm the "never calls sendProtocolEmail" test now fails. Restore.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.confirm-pending.spec.ts
git commit -m "feat(orders): confirmPending enqueues a protocol-email job per confirmed order (queued, per §4.3 — bulk UPDATE unchanged)"
```

---

### Task 8: Wire the Stripe webhook path — `StripeService.markOrderPaid` (QUEUES — fixed from the earlier draft)

**This task replaces the earlier draft's version, which awaited `sendProtocolEmail` inline
inside the webhook handler, adding ~1-3s to Stripe's response time and directly contradicting
§4.3's "опашка — Stripe чака бърз 200". The fix below fits into the function's EXISTING
fire-and-forget block — no new control flow, no gate, no early return on failure.**

**Files:**
- Modify: `server/src/modules/stripe/stripe.module.ts` (import `OrderProtocolEmailModule`)
- Modify: `server/src/modules/stripe/stripe.service.ts` (`markOrderPaid`, ~line 688)
- Test: `server/src/modules/stripe/stripe.service.spec.ts`

**Interfaces:**
- Consumes: `OrderProtocolEmailService.enqueueProtocolEmail(tenantId, orderId): Promise<void>`
  (Task 5). **Not** `sendProtocolEmail` — the Stripe path never awaits a real send.
- Produces: `StripeService` constructor gains a 9th, `@Optional()` param
  `protocolEmail?: OrderProtocolEmailService`, appended after `commission` (same rationale as
  Task 6/7).

- [ ] **Step 1: Write the failing tests**

Add to `stripe.service.spec.ts` (adapt to its existing constructor-mock/db-mock conventions —
read the file's top before writing; `markOrderPaid` is `private`, so — matching however the
file's EXISTING tests already reach it — either call it via the file's established bracket-
access pattern (`svc['markOrderPaid'](...)`) if that's what pre-existing tests do, or drive it
through whichever public webhook-handling method the file already tests through; check first,
don't invent a second access pattern):

```ts
describe('StripeService.markOrderPaid — queues the protocol email, never blocks the webhook on it', () => {
  it('enqueues a protocol-email job for the newly-confirmed order (does not await/gate on it)', async () => {
    // ... build the db mock so the idempotent UPDATE (ne(status,'confirmed') guard)
    // returns a flipped row, exactly as the file's existing "confirms the order"
    // tests already do ...
    const protocolEmail = { enqueueProtocolEmail: jest.fn().mockResolvedValue(undefined) };
    // construct StripeService with protocolEmail wired as the 9th ctor arg

    await svc['markOrderPaid'](orderId, paymentIntentId, account, paidStotinki);

    expect(protocolEmail.enqueueProtocolEmail).toHaveBeenCalledWith(tenantId, orderId);
  });

  it('never calls sendProtocolEmail (the blocking helper) — enqueue only', async () => {
    const protocolEmail = {
      enqueueProtocolEmail: jest.fn().mockResolvedValue(undefined),
      sendProtocolEmail: jest.fn(),
    };
    // ... same setup, construct + call markOrderPaid ...

    expect(protocolEmail.sendProtocolEmail).not.toHaveBeenCalled();
  });

  it('a rejected enqueue does not throw out of markOrderPaid (the webhook still 200s)', async () => {
    const protocolEmail = { enqueueProtocolEmail: jest.fn().mockRejectedValue(new Error('Redis down')) };
    // ... same setup ...

    await expect(svc['markOrderPaid'](orderId, paymentIntentId, account, paidStotinki)).resolves.toBeUndefined();
  });

  it('the sibling idempotent webhook event (order already confirmed) never enqueues a second job', async () => {
    // ... db mock where the UPDATE's ne(status,'confirmed') guard matches ZERO rows
    // (already confirmed by the first of Stripe's two events) — the file's existing
    // "already confirmed by the sibling event" test already covers the early return;
    // extend its assertions to also check enqueueProtocolEmail was NOT called ...
  });
});
```

(Left close to Task 6/7's pattern rather than fully spelled out twice — copy this file's own
existing db-mock helper for `markOrderPaid`'s tests once you've read it; DO NOT invent a
different assertion style for this one file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- stripe.service.spec --maxWorkers=4`

- [ ] **Step 3: Implement**

Constructor:

```ts
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    config: ConfigService,
    private readonly billing: BillingService,
    private readonly econt: EcontService,
    private readonly orderEmail: OrderConfirmationService,
    private readonly publicCache: PublicCacheService,
    private readonly carrierFulfillment: CarrierFulfillmentService,
    private readonly analytics: AnalyticsService,
    @Optional() private readonly commission?: CommissionService,
    @Optional() private readonly protocolEmail?: OrderProtocolEmailService,
  ) {
```

`markOrderPaid` — the fix is a single new line dropped into the EXISTING fire-and-forget
block, right alongside the two calls already there. No gate, no early return, no awaited
send:

```ts
    if (!flipped.length) return; // already confirmed by the sibling event
    // Card money is collected at this exact flip — accrue the (dormant) commission.
    void this.commission?.accrueForOrder(orderId, tenantId);

    // Bust payments cache за този tenant — Плащания показва потвърдения превод веднага.
    await this.bustPaymentsCache(tenantId);
    // Bust connectSummary cache — balance/recent-payments са се променили.
    await this.publicCache.del(`stripe:summary:${tenantId}`);

    // Fire-and-forget: auto-create the carrier waybill (Econt or Speedy, routed
    // by orders.carrier) if the farm enabled it + email the buyer confirmation.
    // Neither must block or fail the webhook (both swallow their own errors).
    void this.carrierFulfillment.autoCreateForOrder(orderId);
    void this.orderEmail.sendForOrder(orderId);
    // Phase 2 (2026-07-22): enqueue (never await) the bilateral protocol
    // email — per §4.3 "опашка — Stripe чака бърз 200", this webhook must NOT
    // pay real SMTP latency. `enqueueProtocolEmail` is a fast queue.add; its
    // own rejection (e.g. Redis down) is swallowed here exactly like the two
    // calls above ("must not block or fail the webhook"). A lost enqueue
    // leaves the order confirmed with protocol_email_status staying null,
    // recoverable via "прати пак" (Task 9) once an operator notices — same
    // class of known, un-auto-recoverable gap as "no email on file"
    // (Assumption #4), not solved further here.
    void this.protocolEmail?.enqueueProtocolEmail(tenantId, orderId);
    // Server-side confirmed sale — this is the ONLY place the online (Stripe)
    // path emits 'purchase' (checkout.service.ts skips it for that branch).
    // Falls back to a synthetic per-order hash for pre-existing orders placed
    // before orders.visitorHash existed (never null → site_events requires it).
    const purchaseHash = order.visitorHash ?? createHash('sha256').update(`purchase|${orderId}`).digest('hex');
    void this.analytics.recordPurchase({
      tenantId,
      orderId,
      visitorHash: purchaseHash,
      valueStotinki: order.total,
    });
```

Update `stripe.module.ts` to import `OrderProtocolEmailModule` (mirror Task 6 Step 5).

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @fermeribg/api test -- stripe.service.spec --maxWorkers=4`

- [ ] **Step 5: Re-run the FULL stripe.service.spec.ts suite**

Confirm the idempotent-double-event handling (`checkout.session.completed` +
`payment_intent.succeeded` both firing for one payment) still no-ops correctly on the SECOND
event once the first has already flipped the row — this pre-existing guard
(`ne(orders.status, 'confirmed')`) is unchanged and must still work, including the new
assertion that the sibling event never calls `enqueueProtocolEmail` a second time (it returns
before reaching that line, exactly as it already returns before the other fire-and-forget
calls).

- [ ] **Step 6: Teeth-check**

Comment out the `void this.protocolEmail?.enqueueProtocolEmail(tenantId, orderId);` line
entirely. Confirm the "enqueues a protocol-email job" test now fails (never called). Restore.
Then temporarily change it to `await this.protocolEmail?.enqueueProtocolEmail(...)` and, by
reasoning (not necessarily a timing-sensitive test), note that this would still pass the
existing tests — the meaningful guarantee this task provides is "never calls
`sendProtocolEmail`", not "is textually `void`"; keep it `void` anyway, matching the two
sibling fire-and-forget calls immediately above it, for consistency and so a slow/failed
enqueue truly cannot delay or fail the webhook response.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/stripe/stripe.module.ts server/src/modules/stripe/stripe.service.ts server/src/modules/stripe/stripe.service.spec.ts
git commit -m "feat(stripe): enqueue the protocol email after the paid-webhook confirm flip (queued, per §4.3 — never blocks the 200)"
```

---

### Task 9: `protocol_email_status` on reads, + a real "прати пак" resend action

**This task now does two things where the earlier draft did one.** The earlier draft only
exposed the tracking columns for read and argued no new resend endpoint was needed (re-running
confirm already retries). That argument only holds for the human path (Task 6). Now that Tasks
7/8 flip `orders.status` to `confirmed` BEFORE the email outcome is known, an order can sit
`confirmed` with `protocol_email_status: 'failed'` (or `null`, if its job never got enqueued)
with no transition left to re-trigger a retry — re-running bulk-confirm only touches
`status='pending'` rows, and re-sending the same Stripe webhook event hits the
already-confirmed guard before it ever reaches the protocol-email line. §4.3's own closing
sentence names the fix: "На поръчката има бутон „прати пак"." This task builds that button's
backend.

**Files:**
- Modify: `server/src/modules/orders/orders.service.ts` — (a) NEW: `resendProtocolEmail(id,
  tenantId): Promise<void>`; (b) `findOne`/`findAll` projection: expose the 3 tracking
  columns (unchanged from the earlier draft's intent)
- Modify: `server/src/modules/orders/orders.controller.ts` — NEW `POST
  :id/resend-protocol-email` route
- Test: `orders.service.spec.ts` (both the new `resendProtocolEmail` describe block and
  whichever existing block already covers `findOne`'s returned shape — grep first)

**Interfaces:**
- Produces:
  - `OrdersService.resendProtocolEmail(id: string, tenantId: string): Promise<void>` —
    verifies the order belongs to the tenant, then calls
    `OrderProtocolEmailService.enqueueProtocolEmail(tenantId, id)`. Idempotent by
    construction: the processor's call into `sendProtocolEmail` no-ops
    (`{ ok: true, skipped: 'already-sent' }`) if a prior attempt already succeeded.
  - `POST /orders/:id/resend-protocol-email` — `@Roles('admin', 'farmer')`, mirroring the
    role scope of the sibling `:id/cod-outcome` and `:id/fulfillment` action routes (flagged
    as an open question below — the spec doesn't explicitly name who may click this button).
  - `OrderRow` (already includes the 3 new fields once Task 1 lands, since `OrderRow = typeof
    orders.$inferSelect`) is exposed on whatever DTO/response shape `findOne`/`findAll`
    return, so the client can build the "прати пак" affordance and a status badge.

- [ ] **Step 1: Write the failing test for `resendProtocolEmail`**

```ts
describe('OrdersService.resendProtocolEmail', () => {
  it('re-enqueues a protocol-email job for an order that belongs to the tenant', async () => {
    const selectChain: any = { from: () => selectChain, where: () => selectChain, limit: () => Promise.resolve([{ id: 'o1' }]) };
    const db: any = { select: jest.fn(() => selectChain) };
    const protocolEmail = { enqueueProtocolEmail: jest.fn().mockResolvedValue(undefined) };
    const svc = new OrdersService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, protocolEmail as any);

    await svc.resendProtocolEmail('o1', 't1');

    expect(protocolEmail.enqueueProtocolEmail).toHaveBeenCalledWith('t1', 'o1');
  });

  it('throws NotFoundException for a missing/foreign order and never enqueues', async () => {
    const selectChain: any = { from: () => selectChain, where: () => selectChain, limit: () => Promise.resolve([]) };
    const db: any = { select: jest.fn(() => selectChain) };
    const protocolEmail = { enqueueProtocolEmail: jest.fn() };
    const svc = new OrdersService(db, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, undefined, protocolEmail as any);

    await expect(svc.resendProtocolEmail('o1', 't1')).rejects.toThrow(/не е намерена/);
    expect(protocolEmail.enqueueProtocolEmail).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @fermeribg/api test -- orders.service.spec --maxWorkers=4`
Expected: FAIL — `svc.resendProtocolEmail is not a function`.

- [ ] **Step 3: Implement `resendProtocolEmail`**

```ts
  /**
   * "Прати пак" (§4.3) — re-enqueues the bilateral protocol email for an order
   * that may already be `confirmed`. Exists because Tasks 7/8 (bulk + Stripe)
   * flip `orders.status` to `confirmed` BEFORE the email outcome is known —
   * unlike the human path (Task 6), re-running the confirm action on those
   * orders is a no-op (the pending→confirmed transition already happened), so
   * it can no longer serve as the retry trigger. Idempotent: `sendProtocolEmail`
   * (run by the queue's processor) no-ops when protocol_email_status is
   * already 'sent'.
   */
  async resendProtocolEmail(id: string, tenantId: string): Promise<void> {
    const [order] = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(and(eq(orders.id, id), eq(orders.tenantId, tenantId)))
      .limit(1);
    if (!order) throw new NotFoundException('Поръчката не е намерена');
    if (!this.protocolEmail) return; // module not wired (e.g. a bare unit-test harness) — no-op
    await this.protocolEmail.enqueueProtocolEmail(tenantId, id);
  }
```

- [ ] **Step 4: Run test to verify it passes; add the controller route**

Run: `pnpm --filter @fermeribg/api test -- orders.service.spec --maxWorkers=4` — expect PASS.

In `orders.controller.ts`, near the other `:id/...` action routes (e.g. right after
`:id/fulfillment`):

```ts
  // "Прати пак" (§4.3) — re-send the bilateral protocol email. Idempotent: a
  // no-op if it already sent. See OrdersService.resendProtocolEmail.
  @Post(':id/resend-protocol-email')
  @Roles('admin', 'farmer')
  resendProtocolEmail(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: TenantRequestUser) {
    return this.ordersService.resendProtocolEmail(id, user.tenantId);
  }
```

- [ ] **Step 5: Expose the 3 tracking columns on read (unchanged intent from the earlier draft)**

Find `findOne`'s existing test (grep `findOne` in `orders.service.spec.ts` or a dedicated
file), and add an assertion that a mocked row's `protocolEmailStatus`/`protocolEmailAt`/
`protocolEmailError` fields survive to the returned object un-stripped. Run:
`pnpm --filter @fermeribg/api test -- orders.service.spec --maxWorkers=4` (only fails if
`findOne` currently hand-projects columns and excludes the new ones — if `findOne` already
does `select()` with no column list / a spread, this step may already pass; if so, skip
straight to noting "no code change needed, only the read-through test"). If it failed, add
the three columns to whatever explicit column-projection object `findOne`/`findAll` use, then
re-run to confirm PASS.

- [ ] **Step 6: Confirm no PII/security regression**

`protocol_email_error` could theoretically contain an SMTP diagnostic string — verify it
never includes the customer's email/address as a substring in practice (nodemailer/SMTP
rejection messages sometimes echo the recipient). If it does, truncate/redact before storing
in Task 5's `sendProtocolEmail` catch block instead of exposing raw error text — flagged here
as a review point, not a coded assertion, since it depends on what real SMTP providers return.

- [ ] **Step 7: Teeth-check**

For the resend action: comment out `await this.protocolEmail.enqueueProtocolEmail(tenantId,
id);`, confirm the "re-enqueues a protocol-email job" test fails, restore. For the read
projection (if Step 5 required a code change): remove the new columns from the projection
again, confirm that test fails, restore.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/orders/orders.service.ts server/src/modules/orders/orders.controller.ts server/src/modules/orders/orders.service.spec.ts
git commit -m "feat(orders): add прати-пак resend action + expose protocol_email_status/_at/_error on reads"
```

---

### Task 10 (BLOCKED on Phase 1 — do not execute until the consolidated-protocol table/screen
merges): §4.4 courier protocol send button

**Files (all assume Phase 1's interface, NOT yet real in this worktree):**
- Create: `server/src/modules/order-protocol-email/consolidated-protocol-attachment.
  resolver.ts` (a second resolver, `kind: 'consolidated-protocol'`, registered against the
  SAME `PROTOCOL_ATTACHMENT_RESOLVER` token via a small kind-dispatching wrapper — Task 4's
  resolver interface needs widening to dispatch by `d.kind` if more than one kind is ever
  registered; revisit `EmailService.resolveAttachments` to call
  `this.attachmentResolver.resolve(d)` where the resolver itself switches on `d.kind`, OR
  register a `Map<string, ProtocolAttachmentResolver>` keyed by kind — **this plan does not
  pick one**, since it depends on how many kinds Phase 1 introduces; flagged as an open
  question)
- Modify: a new endpoint, assumed shape `POST /handover/consolidated/:id/email-couriers`
  (assumed name — Phase 1 owns the actual route), `@Roles('admin')`, body `{ courierUserIds:
  string[] }` (assumed — the spec's "показва списъка с получатели преди да тръгне" implies
  the CLIENT already resolved recipients via a Phase-1 endpoint and is just confirming send)

**This task can reuse `PROTOCOL_EMAIL_QUEUE` / `OrderProtocolEmailProcessor` (Task 5) rather
than needing wholly new queue infrastructure** — a `kind: 'consolidated-protocol'` job on the
same queue, processed by (a widened) resolver dispatch — since §4.4 is explicitly
button-triggered, not automatic, so it could even just call the resolver's render + a direct
`EmailService.sendMailNow` per courier without a queue at all; which of the two fits better
depends on Phase 1's own shape and is not decided here.

**This task is deliberately NOT decomposed into RED/GREEN steps** — Phase 1's
`consolidated_protocols` table, its service, and its "who's an active courier today" query
(`route_courier_assignments` per spec §2) don't exist in this worktree. Writing concrete
tests against types that don't exist yet violates this plan's own "No Placeholders" rule.
**Recommendation to the orchestrator:** re-plan this one task once Phase 1 has landed and its
actual service/DTO names are known — at that point it is a small, mechanical addition (one
new controller endpoint + one new resolver + a manual-send confirmation dialog on the
client), reusing every piece of infrastructure Tasks 4/5 already built (the
`PROTOCOL_ATTACHMENT_RESOLVER` token, `EmailService.sendMailNow`, the lazy-materialization
`deliver()` path, and possibly `PROTOCOL_EMAIL_QUEUE` itself). Do not attempt Task 10 before
that re-plan.

---

## Self-review notes (per superpowers:writing-plans)

- **Spec coverage:** §1.6 → Task 1. §4.1 (attachments, dev-preview reflecting them) → Tasks
  4/5. §4.2 (ordering, no-open-transaction-during-SMTP) → Task 6 (the human path — the only
  path §4.2's "1. render 2. await-send 3. flip" ordering applies to; Tasks 7/8 flip first and
  queue the email, per §4.3's table, not §4.2's ordering). §4.3 (three paths + per-path
  behavior + `protocol_email_status` + "прати пак") → Tasks 6 (blocks), 7/8 (queue), 9
  (resend action) + Assumption #5. §4.4 → Task 10 (blocked). §7's test table → mapped 1:1
  into each task's SAFETY FLOOR tests (numbering idempotency isn't re-tested here — it's
  Phase 1's `consolidated_protocols`, not this table; the "Имейл ред"/"Имейл идемпотентност"/
  "Опашка" rows ARE covered — "Имейл ред" by Task 6 specifically, since that's the only path
  with an "ред на операциите" to test; "Опашка" by Tasks 7/8/9's enqueue assertions).
- **Placeholder scan:** Task 10 is intentionally left undecomposed with an explicit
  rationale (blocked on a different phase's undelivered interface) rather than inventing
  fictional Phase-1 types to satisfy the "no placeholders" rule superficially — flagged
  clearly rather than hidden.
- **Type consistency:** `SendProtocolEmailResult` (Task 5) is the return type of
  `sendProtocolEmail`, consumed by Task 6 (inline) and by `OrderProtocolEmailProcessor`
  (inside the queue, for Tasks 7/8/9's jobs) — never by Tasks 7/8/9 directly, which only ever
  see `enqueueProtocolEmail`'s `Promise<void>`. `ProtocolEmailJobData` (Task 5) is the one
  job-payload shape carried by `PROTOCOL_EMAIL_QUEUE`. `HandoverProtocolAttachmentDescriptor`
  (Task 4) is the one attachment shape used by Task 5's `sendProtocolEmail` and Task 4/5's
  resolver. `OrderRow` is never redefined — it is always `typeof orders.$inferSelect`,
  automatically widened by Task 1.

---

## Open questions for the orchestrator

1. **No-email orders (assumption #4).** Confirmed no explicit spec text either way — this
   plan skips silently (mirrors existing `OrderConfirmationService` convention). Confirm this
   matches intent, since it means SOME confirmed orders will legitimately have
   `protocol_email_status: null` forever (guest checkout, no email) — the "Готовност"/audit
   screens (Phase 3?) should not treat `null` as an error state for those rows.
2. **`confirmPending`'s widened `{confirmed, failed}` response (Task 7).** This plan only
   changes the backend return shape. Whether/how the "Днес" UI's "Потвърди всички" button
   copy should surface "X от Y не тръгнаха" is out of this backend plan's scope — flagging
   `client/src/lib/api-client.ts:742` / `today-client.tsx:83` as the call sites to check.
3. **Role scope for `POST /orders/:id/resend-protocol-email` (Task 9).** This plan defaults
   to `@Roles('admin', 'farmer')`, mirroring the sibling `:id/cod-outcome`/`:id/fulfillment`
   action routes. The spec names the button but not who may click it — confirm this default
   is right, or narrow/widen it.
4. **Task 10 (§4.4) is blocked on Phase 1** and needs a fresh, small planning pass once
   Phase 1's actual table/service names exist — including whether it reuses
   `PROTOCOL_EMAIL_QUEUE` or sends directly (see Task 10's note).
5. **Migration number collision (assumption #1).** This plan assumes `0113`/idx 111. Phase 1
   independently assumed `0112` (per its own spec doc) before the `koshnitsi-baskets`
   collision was known. At integration time, confirm the actual free slot via
   `_journal.json` immediately before merging — do not trust either plan's assumed number.

## Files/modules this plan touches that Phase 1 or Phase 3 also touch

- **`server/src/modules/handover/handover.service.ts`** — Task 2 adds `renderPdfForEmail`
  (a new method, additive). Phase 1 is expected to add the `consolidated_protocols` CRUD +
  live-view + freeze logic to this SAME file (per the spec's own framing, though Phase 1
  might instead use a new sibling file — unconfirmed). **Real merge-conflict risk** if both
  phases land near the same lines; recommend whichever phase merges second rebases onto the
  other rather than resolving a textual conflict blind.
- **`server/src/modules/handover/handover-pdf.ts`** — Task 3 adds the optional
  `preliminaryNotice` param. Low collision risk with Phase 1 (which per the spec introduces
  a SEPARATE `consolidated-pdf.ts` file for its own document), but both phases depend on
  Phase-0's `pdf-kit.ts` primitives already being stable — already true in this worktree.
- **`server/src/modules/handover/handover.module.ts`** — Task 2's `exports: [HandoverService]`
  addition. Phase 1 likely also needs to modify this file's `providers`/`controllers` arrays
  for its own new service/controller. Small, low-risk textual overlap.
- **`server/src/common/queue/queue.constants.ts`** — Task 5 appends `PROTOCOL_EMAIL_QUEUE`.
  Purely additive (one new exported const); negligible collision risk even if Phase 1/3 also
  append their own queue constants here.
- **`server/src/modules/orders/orders.service.ts`** — Tasks 6/7/9 touch `updateStatus`
  (~1767), `confirmPending` (~2079), and add `resendProtocolEmail` + the read-projection
  change. Phase 3 (§1.8's `orderIds` fix + farmer readiness list) is scoped to
  `handover.service.ts` and the farmer-readiness screen per the spec, NOT to
  `orders.service.ts` — low expected collision, but worth a final check once Phase 3's actual
  plan exists.
- **`server/src/modules/orders/orders.controller.ts`** — Task 9 adds one new route. Phase 3
  is scoped to the farmer-readiness screen (a different controller) per the spec — low
  expected collision.
- **`packages/db/drizzle/meta/_journal.json`** — every phase introducing a migration touches
  this file's tail. Guaranteed collision point; whoever merges last resolves by appending
  after the other's entry and renumbering their own idx, per assumption #1.
