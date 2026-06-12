# Production Date Navigation — Design Spec
Date: 2026-06-12

## Problem

The "Производство" screen uses a native `<input type="date">` overlaid on a styled label (opacity-0, absolute inset-0). Issues:

1. **Click bug**: On Windows Chrome the invisible input sometimes fails to receive the pointer event, giving no feedback.
2. **1-year scalability**: Navigating month-by-month in a native date picker becomes painful after many months of history.
3. **No quick adjacent-day navigation**: Must open picker and click, even for +1 day.

## Design

### Date Nav Bar

```
[←]  Петък, 13 Юни 2026  [Днес]  [↓]  [→]
```

Three zones inside a single pill-shaped container (border, rounded-xl, bg-ff-surface):

| Zone | Content | Behavior |
|------|---------|----------|
| Left arrow `←` | ChevronLeft icon | `selected - 1 day` → router.push |
| Center label | Weekday + date string + optional "Днес" badge | Click → toggle calendar popup |
| Right arrow `→` | ChevronRight icon | `selected + 1 day` → router.push |

"Днес" badge: small green pill, visible only when selected date ≠ today.

### Calendar Popup

Inline block below the bar (not a modal/portal — avoids z-index issues). Appears on label click, dismisses on:
- Selecting a day
- Clicking the label again (toggle)
- Clicking outside (document mousedown listener, cleaned up on unmount)

Popup contents:
- **Header row**: `← [Месец Година] →` for month navigation
- **Weekday row**: Пн Вт Ср Чт Пт Сб Нд
- **Day grid**: 7 columns, fills with prev/next month ghost days (disabled, dimmed)
- **Footer**: "Към днес" button (right-aligned)

Day states:
- Default: clickable, hover bg-ff-surface-2
- Today: green-tinted bg, font-bold (when not selected)
- Selected: solid green bg, white text
- Other month: dimmed, disabled

### Routing

Same as before: `router.push('/production?date=YYYY-MM-DD')` on any date change.

## Files

| File | Change |
|------|--------|
| `client/src/components/production/DateNavBar.tsx` | New component |
| `client/src/components/production/prep-list.tsx` | Replace label+input block with `<DateNavBar>` |

No new dependencies. No library needed. Uses existing `bgDateLabel` util for display string, BG_MONTHS/BG_DAYS arrays from utils.

## Utilities to reuse

From `client/src/lib/utils.ts`:
- `bgDateLabel(d: Date)` → "Петък, 13 Юни 2026 г." (strip " г." suffix)
- `BG_MONTHS` array (already exported or inline-duplicatable)

## Data flow

- `DateNavBar` receives `date: string` (YYYY-MM-DD) as prop
- Uses `useRouter()` internally for navigation
- Calendar view state (displayed month) is local — does not affect URL until day is clicked

## Non-goals

- No animation on calendar open/close
- No range selection
- No keyboard navigation (can add later)
- No library dependency
