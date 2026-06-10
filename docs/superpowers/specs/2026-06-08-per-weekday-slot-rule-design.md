# Per-weekday recurring slots + cleaner time entry

**Date:** 2026-06-08
**Branch:** `feat/per-weekday-slot-rule`

## Problem

The recurring self-delivery rule (`settings.slotRule`) forces ONE global time
window across every picked weekday. A farmer who delivers Mon 10–12 but Wed 16–18,
or who can't deliver some days, can't express that. The admin time input is the
native `<input type="time">` which renders 12h AM/PM on the user's browser
(start 12:31 PM, end 12:00 PM → end-before-start → reject) — the "buggy hours".

Goals:
1. Per-weekday hours **and** capacity. Off day = not configured.
2. Replace the AM/PM time input with 24h dropdowns (no typos, no end<start).
3. Helper text explaining the rule is configurable to the farmer's real availability.
4. Пазар Чайка shows only available slots the farmer set — already true at the API
   level (`findPublicBySlug` returns only `remaining>0`); confirmed, no change.

## Rule model (`slot-rule.ts` + client `types.ts`)

```ts
SlotWindow = { timeFrom: 'HH:MM'; timeTo: 'HH:MM'; maxOrders: number }
SlotDay    = SlotWindow & { dow: number }          // 0=Sun..6=Sat
SlotRule = {
  active; repeat: 'weekdays'|'interval';
  days: SlotDay[];                                  // weekdays mode
  intervalDays; intervalWindow: SlotWindow;         // interval mode
  anchorDate; customerNote?; driverNote?;
  horizonDays; skipDates[]; lastMaterializedDate?
}
```

**Migration (read-time, `migrateRule`):** old rules with `weekdays:number[]` +
top-level `timeFrom/timeTo/maxOrders` upgrade to
`days = weekdays.map(dow => ({dow, timeFrom, timeTo, maxOrders}))` and
`intervalWindow = {timeFrom, timeTo, maxOrders}`. Applied in `getRule` and inside
`normalizeRule(prev)` so demo/prod farms keep working with no data loss.

## Generator

`slotRuleDates(rule, today): string[]` → `slotRuleSlots(rule, today): GenSlot[]`
where `GenSlot = { date; timeFrom; timeTo; maxOrders }`.
- weekdays: build `Map<dow, SlotWindow>` from `days`; for each date in
  `[max(today,anchor) … today+horizon]` whose dow is in the map and not skipped,
  emit one GenSlot with that day's window.
- interval: step every `intervalDays` from anchor; emit GenSlot with `intervalWindow`.

Still **one generated slot per date**, so dedup-by-date, skipDates, and the
delete-future-unbooked rebuild logic are unchanged. `materializeRule` inserts each
GenSlot's own `timeFrom/timeTo/maxOrders` (was the rule's single window).

## Validation (`normalizeRule`)

- weekdays mode: ≥1 day; each day unique `dow` 0..6; each window `HH:MM`,
  `timeTo>timeFrom`, `maxOrders≥1`.
- interval mode: `intervalDays≥1`; `intervalWindow` valid.
- `horizonDays` clamped 1..60. `skipDates` preserved from prev.

## DTO (`dto/slot-rule.dto.ts`)

Rewrite `SaveSlotRuleDto` with nested `@ValidateNested`:
`SlotWindowDto`, `SlotDayDto extends SlotWindowDto`, top-level `days: SlotDayDto[]`,
`intervalWindow: SlotWindowDto`, `intervalDays`, plus existing scalar fields.

## Admin UI (`recurrence-card.tsx`)

- **24h dropdown selects** for start/end, 30-min steps, 05:00–22:00. Replaces
  native time inputs.
- **"Еднакви часове за всички дни" toggle (default ON):** one shared
  `[from▾]–[to▾] cap` row applied to every picked day (common case). Toggle OFF →
  one row per picked day (`Пн [10:00▾]–[12:00▾] cap 5`). Adding a day seeds from the
  shared window. On load, `sameHours` = all days share an identical window.
- Mode toggle weekdays/interval stays; interval mode shows `intervalDays` + one
  shared window row.
- Short description line under the title + extended `SLOTS_HELP`.

## Chaika

No change. Slot type unchanged; generated slots now carry per-day times; public
endpoint already filters to `remaining>0`.

## Tests

Rewrite `slot-rule.spec.ts`: per-day generation, migration of legacy rules,
per-day validation, skipDates, interval mode. Keep full server suite green.

## YAGNI (held back)

Multiple windows per day; per-day notes (notes stay global).
