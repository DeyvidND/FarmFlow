# Handover protocol — prose layout redesign

Date: 2026-07-16
Status: Approved (brainstorming), implementing
Repo: FarmFlow · Branch: `feat/routes-courier-reminder`

## Problem

The generated handover PDFs (`server/src/modules/handover/handover-pdf.ts`) use a terse
key/value layout (title, „Предал:", „Приел:", „Стока:" bullet list, „Общо:" total). The
operator wants them to read like a conventional Bulgarian **приемо-предавателен протокол**:
a centered title, a prose „Днес, …" opening sentence naming both parties, a numbered
inventory list, signature lines at the foot. And to auto-fill as much from system data as
possible.

Reference: a real property-handover протокол (община Русе ↔ „Ивас" ЕООД) — prose opener,
numbered item list, „Предал:"/„Приел:" at the bottom.

## Decisions (from brainstorming)

1. **Both kinds** get the new prose layout: `farmer_to_operator`
   (ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ) and `operator_to_customer` (РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА).
2. **Reason line = generic + order numbers.** „във връзка с доставка на селскостопанска
   продукция по поръчки № …" (farmer leg) / „във връзка с поръчка № …" (customer leg),
   numbers pulled from the protocol's orders.
3. **Printed items only**, plus **2 empty dotted continuation lines** for optional
   hand-written additions on the round.
4. **Plain list, no prices, no Общо.** Each line: `N. productName · variant — quantity unit`.
   Money is still stored (COD `total_stotinki`) — only hidden on the PDF.

Out of scope: the on-screen sign dialog (`protocol-dialog.tsx`) — that's the operator's
input/review UI, keeps showing value/Общо. No DB migration.

## Layout (A4 portrait, DejaVuSans regular; title faux-bold via double-draw)

```
                 ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ            ← centered, faux-bold, underlined
                            № {protocolNumber}          ← omitted if null (preview)

Днес, {DD.MM.YYYY г.}, {FROM descriptor}, предаде на {TO descriptor}, във връзка с
доставка на селскостопанска продукция по поръчки № {orderNumbers}, долуописаните стоки:
                                                        ← wrapped prose, kind-aware

   1. {productName}{ · {variantLabel}} — {quantity} {unit}
   2. …
   ..................................................    ← 2 dotted continuation lines
   ..................................................

Настоящият протокол се състави в два еднообразни екземпляра — по един за всяка страна.

Предал: ____________________     Приел: ____________________
        {FROM.name}                      {TO.name}          ← printed names; PNG if digital
```

- **Party descriptor** = `name` + optional `(ЕИК {eik})` or `(рег.№ {regNo})` + optional
  `, адрес {address}`. Customer `to` = name + optional `, адрес {address}` (no ЕИК).
- **Title / wording by kind:** farmer → „ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ" + „протокол"/„поръчки
  №"; customer → „РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА" + „разписка"/„поръчка №".
- **Order numbers** absent (old rows) → the „по поръчки №" fragment is dropped cleanly.
- **Signature PNG:** embedded above the line when `sign_mode='digital'`; else blank ruled
  line (paper/pending). Malformed PNG falls back to the blank line (existing behaviour).

## Backend changes

`handover.service.ts`:
- `buildDraft` (farmer leg) & `buildCustomerLegDraft` also select `orders.orderNumber`;
  return a distinct, sorted `orderNumbers: number[]`.
- Persist `orderNumbers` into the row's existing **`meta` jsonb** (`meta.orderNumbers`) at
  every insert path: `createSigned`, `createBatch`, `ensureDraftTarget`, `signPaperTarget`;
  and pass it through `renderPreviewPdf`'s synthetic row. No schema/migration.

`handover-pdf.ts`: full rewrite per layout above. Adds a `wrapText(font,size,maxWidth)`
helper (`font.widthOfTextAtSize`) — pdf-lib does not wrap.

## Testing

Extend `handover-pdf.spec.ts`:
- both kinds still produce a non-empty `%PDF-` buffer (Cyrillic, no encoding throw);
- malformed `fromSignaturePng` still falls back (no crash);
- a row **with** `meta.orderNumbers` renders (order-number fragment path exercised);
- a row **without** `meta` renders (fragment omitted, back-compat).

Service tests (`handover.service.spec.ts` if present): `buildDraft` returns `orderNumbers`
distinct across a farmer's multiple orders in a slot; customer leg returns the single order
number.
