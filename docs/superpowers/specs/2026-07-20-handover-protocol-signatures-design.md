# Handover protocols — saved encrypted signatures, .doc-style layout, offline „Проверка" view

**Date:** 2026-07-20
**Branch:** `handover-protocol-signatures` (off `origin/main` @ 8d125a7f)
**Status:** Design approved — ready for implementation plan

## Problem

Three pain points in the приемо-предавателен-протокол (handover-protocol) feature:

1. **Signatures are re-drawn every single protocol.** Captured ad-hoc in
   `ProtocolDialog` via `SignaturePad`, stored as **plaintext** base64 PNG on the
   protocol row. A farmer signs the same squiggle over and over; nothing is saved on
   their profile. Painful on a phone.
2. **No fast way to show protocols on the road.** When police stop the courier mid-
   delivery they must show the day's handover documents quickly. Today the only
   surface is the operator panel's protocols list + per-row PDF opened one at a time —
   and it needs internet.
3. **The PDF doesn't look like the official document.** Current layout is a single
   prose sentence („Днес, …, X предаде на Y …"). The reference `.doc` is the classic
   two-party bilateral form (title → „Днес, на … в гр. … между:" → party-1 block →
   „и" → party-2 block → „се състави …" → numbered goods → „в … еднообразни
   екземпляра" → ПРЕДАЛ / ПРИЕЛ).

## Goals

- Farmers and the operator each save **one** signature (+ contact info) in their
  profile/settings; store it **encrypted at rest**; capture is dead-simple on a phone
  with a preview before saving.
- Signing a farmer→operator handover becomes **one tap** (both saved signatures
  auto-filled). Customer receipts auto-fill the operator side; the customer signs on
  the spot (or „без подпис").
- The protocol PDF **matches the `.doc` structure** using our real data.
- A dedicated fullscreen **„Проверка"** view shows the day's signed protocols big and
  swipeable, **cached to work offline** (rural roads, no signal).

## Non-goals

- No exact 1:1 replica of the `.doc` (its ЕГН / факс / длъжност fields don't apply —
  our parties are legal entities with ЕИК). We match the **structure**, not empty
  inapplicable blanks.
- No full PWA / service-worker rewrite. Offline = cache the day's data in IndexedDB.
- No farmer self-service login flow change — the farmer's signature is captured in the
  farmer profile the operator already edits (hand the phone to the farmer once).

## Decisions (from brainstorming)

| # | Decision |
|---|----------|
| Layout | Match `.doc` **structure** with our real fields (ЕИК not ЕГН; тел/email/адрес; drop факс/длъжност). |
| Signatures | Save **farmer + operator** signatures once, encrypted; auto-fill → 1-tap sign. |
| Police view | Fullscreen **„Проверка"** in the operator **panel** (client); **offline-cached**. |
| Encryption | Reuse existing `encryptSecret`/`decryptSecret` (AES-256-GCM, `ENCRYPTION_KEY`). |

## Architecture

### A. Data model (migration `0110_handover_signatures`, journal idx 108)

- `farmers.signature_png text` — **encrypted** signature blob (`iv:tag:ct`), NULL = none.
- `tenants.operator_signature_png text` — **encrypted** operator signature blob.
- The protocol snapshot columns `handover_protocols.from_signature_png` /
  `to_signature_png` become encrypted **on new writes**. A `maybeDecrypt(v)` helper
  passes through anything not shaped like our ciphertext (`^[A-Za-z0-9+/=]+:...:...$`
  with 3 colon-separated base64 parts) so **legacy plaintext rows keep rendering** — no
  data migration of existing rows.

Encryption/decryption is **server-side only**. Public projections (`findPublicBySlug`,
storefront farmer DTO) **never** include the signature. Operator-scoped reads
(`GET /farmers/:id`, `GET /tenants/legal`, the check-view payload) return the
**decrypted** PNG so the panel can preview/render it — encryption protects the DB at
rest, not the authenticated owner.

### B. Signature capture component — `SignaturePadField` (client)

Reusable, mobile-first. Supersedes / wraps the current `SignaturePad`.

- High-DPI canvas: size backing store to `cssW*dpr × cssH*dpr`, scale the 2D context by
  `dpr` → crisp strokes on retina phones. Guard against re-scaling on re-render.
- `touch-action: none`, pointer events (already correct), full-width, tall on mobile.
- Controls: „Изчисти", live „празно / нарисуван" state.
- **Preview before save:** a framed „Преглед" rendering the captured PNG exactly as it
  will print (white box, same aspect as the PDF signature slot).
- Saved state: shows the stored signature image + „Промени" / „Изтрий".
- Emits a PNG data-URL; parent persists it.

Placement:
- **Farmer profile** (`farmer-panel.tsx`): a „Подпис на фермера" section (near legal
  data), plus surfacing тел/e-mail that already exist on the farmer.
- **Operator settings** (`legal-card.tsx`): a „Подпис на оператора" section.

Server endpoints:
- `PATCH /farmers/:id` accepts `signaturePng: string | null` → encrypt + store.
- `PUT/PATCH tenant legal` (existing tenants legal controller) accepts
  `signaturePng: string | null` for the operator.
- Reads return the decrypted value to the owner only.

### C. Protocol PDF — `.doc` structure (rewrite `handover-pdf.ts`)

`composeProtocol` + `renderProtocolPdf` reshaped to:

1. **Title** centered, faux-bold, underlined: „ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ"
   (farmer leg) / „РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА" (customer leg). „№ N" beneath.
2. **Opening line:** „Днес, {дата} г., в гр. {град}, между:" — `град` derived from the
   operator legal `address` (first recognizable settlement token; graceful drop of
   „в гр. …" when unknown).
3. **Party block 1 „ПРЕДАВА:"** — name; ЕИК/БУЛСТАТ or рег.№ (per `kind`); адрес;
   телефон; e-mail. (farmer leg → farmer; customer leg → operator.)
4. **„и"** centered.
5. **Party block 2 „ПРИЕМА:"** — same fields; a customer party prints name/тел/адрес,
   no ЕИК.
6. „**се състави настоящият приемо-предавателен протокол за долуописаните стоки:**"
7. **Numbered goods** — `N. {product}[ · {variant}] — {qty}{unit}`, plus a couple of
   dotted continuation lines for hand additions.
8. **Footer:** „Настоящият протокол се състави в два еднообразни екземпляра — по един
   за всяка страна." (two copies — we have no third-party company, unlike the `.doc`).
9. **Signatures:** „ПРЕДАЛ:" / „ПРИЕЛ:" columns — embedded signature PNG (decrypted) +
   printed name + `/…………/`.

Party/field derivation lives in the pure `composeProtocol`; the drawing stays in
`renderProtocolPdf`. `composeProtocol` remains unit-testable text-only.

### D. One-tap signing

- `HandoverService.createSigned`: if the DTO omits a side's signature, auto-fill it —
  farmer leg → `from` = farmer's saved sig, `to` = operator's saved sig; customer leg →
  `from` = operator's saved sig (customer `to` still from the dialog). Result is a
  fully digital, `signMode: 'digital'` protocol.
- `signPaperTarget` / `signAllForDay` gain a digital path: when saved signatures exist,
  sign **digitally** with them rather than marking paper.
- Protocols screen (`protocols-client.tsx`): „Подпиши дигитално" becomes a **1-tap**
  „Подпиши" when both saved sigs exist — a quick confirm sheet previews the two
  signatures + parties, no drawing. If the farmer has **no** saved signature → fall
  back to the current draw dialog and nudge them to save one on the profile.

### E. „Проверка" view — panel, offline (client)

- New route `client/src/app/(admin)/protocols/check/page.tsx` + a prominent „Проверка"
  button on the protocols screen (and an entry from the route screen).
- Fullscreen, minimal chrome. The day's **signed** protocols as large, swipeable cards:
  title, №, date, both parties, goods list, „Подписан ✓", both signatures. **Pure HTML**
  (no PDF dependency) → instant, offline-renderable.
- New endpoint `GET /handover/check?date=` → the day's signed protocols with decrypted
  signatures, shaped for display (operator-scoped).
- **Offline cache:** on a successful online load, persist the payload to **IndexedDB**
  keyed by date; the view reads cache-first and renders it if the network fails. Shows
  „кеширано в HH:MM". A tiny IndexedDB helper (no new deps); fall back to `localStorage`
  with a size guard if IndexedDB is unavailable.

### F. impeccable pass (req #4)

After the feature works end-to-end, run `impeccable:critique` / `impeccable:audit` on
the new signature capture, the check view, and the protocol confirm sheet — focus 375px,
a11y (canvas labelling, focus, contrast), and polish. Implement P0–P2 findings.

## Testing

- **Server (jest):** signature encrypt/decrypt round-trip + `maybeDecrypt` legacy
  pass-through; `createSigned` auto-fills saved signatures; `composeProtocol` emits the
  new two-party structure (text assertions); migration applies. Run the **full** suite.
- **Client (vitest, Node-only — no jsdom/RTL):** pure logic only — `SignaturePadField`
  data extraction bits, city-from-address parser, IndexedDB cache read/write wrapper
  (mock the store). No component-render tests.
- **Live verify:** dev server + Browser pane at 375px — draw + save a signature, 1-tap
  sign a farmer pickup, open the new-layout PDF, open „Проверка" and confirm it renders
  from cache with the network throttled/offline.

## Rollout / ops notes

- `ENCRYPTION_KEY` already exists in prod env (Econt passwords use it) — no new secret.
- Migration is additive (new nullable columns) — safe; deploy runs migrator before app
  images. No backfill.
- Backend-first ordering not required (columns are additive, old rows still render), but
  the new `GET /handover/check` endpoint must ship before the check view calls it —
  same deploy is fine.

## Open risks

- **City parsing** from a free-text address is heuristic; degrade gracefully (omit).
- **IndexedDB quota / private mode** — guard every store op in try/catch; the view must
  still work online-only if caching fails.
- **Signature PNG size** — cap canvas export dimensions so cached payloads stay small.
