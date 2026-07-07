'use client';

/**
 * Delivery day picker — day-granularity booking (migration 0081): a slot is a
 * whole delivery day with a capacity, not an hour range. Date pills span the
 * next 14 days (today..+13); a pill with `byDate[iso].length > 0` is directly
 * pickable — clicking it selects that day's (single) slot, no hour sub-list.
 * Full/booked days never come back from the API, so an unpickable pill just
 * has no rows behind it. When the whole window is empty (farm delivery
 * disabled, or no capacity) the picker renders nothing and reports it via
 * `onAvailabilityResolved`, so the checkout can drop the slot requirement.
 *
 * Fully controlled: the selected `slotId` lives in the parent; this component
 * only surfaces picks through `onChange`.
 */
import { useEffect, useMemo, useState } from 'react';
import { getSlots, resolveSlug, type PublicSlot } from '@/lib/api';
import { Check } from './icons';

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд']; // Mon-first
const MONTHS = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];
/** Day-granularity booking needs more lookahead than the old hour picker. */
const WINDOW_DAYS = 14;

interface DayPill {
  iso: string; // YYYY-MM-DD (UTC — lines up with the seeded slot window)
  dayNum: number;
  weekday: string;
  month: string;
  display: string; // "2 юни"
}

/** Next `WINDOW_DAYS` calendar days starting today, in UTC so the iso strings
 *  match the seed. */
function buildWindow(): DayPill[] {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: WINDOW_DAYS }, (_, i) => {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    const dayNum = d.getUTCDate();
    const month = MONTHS[d.getUTCMonth()];
    return {
      iso: d.toISOString().slice(0, 10),
      dayNum,
      weekday: WEEKDAYS[(d.getUTCDay() + 6) % 7],
      month,
      display: `${dayNum} ${month}`,
    };
  });
}

export interface SlotPickerProps {
  /** Currently selected slot id (controlled by the parent). */
  value: string | null;
  /** Fired on pick (id + human label) and on clear (both null). */
  onChange: (slotId: string | null, label: string | null) => void;
  /** Fired once loading settles, with whether any slot exists across the window. */
  onAvailabilityResolved?: (hasAny: boolean) => void;
}

export function SlotPicker({ value, onChange, onAvailabilityResolved }: SlotPickerProps) {
  const slug = useMemo(() => resolveSlug(), []);
  const days = useMemo(buildWindow, []);
  const [byDate, setByDate] = useState<Record<string, PublicSlot[]> | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // One ranged request for the whole window instead of one fetch per day.
      const rows = await getSlots(slug, {
        from: days[0].iso,
        to: days[days.length - 1].iso,
      }).catch(() => [] as PublicSlot[]);
      if (!alive) return;
      const map: Record<string, PublicSlot[]> = {};
      days.forEach((d) => {
        map[d.iso] = [];
      });
      rows.forEach((s) => {
        (map[s.date] ??= []).push(s);
      });
      setByDate(map);
      onAvailabilityResolved?.(rows.length > 0);
    })();
    return () => {
      alive = false;
    };
    // slug + days are stable for the component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (byDate === null) {
    return (
      <p className="muted" style={{ fontSize: 14 }}>
        Зареждане на свободни дни…
      </p>
    );
  }

  // Nothing free anywhere → hide the module (delivery off or fully booked).
  const hasAny = days.some((d) => byDate[d.iso].length > 0);
  if (!hasAny) return null;

  const selectedDay = days.find((d) => byDate[d.iso].some((s) => s.id === value)) ?? null;
  const selectedSlot = selectedDay
    ? (byDate[selectedDay.iso].find((s) => s.id === value) ?? null)
    : null;

  const pickDay = (d: DayPill) => {
    const slot = byDate[d.iso][0];
    if (!slot || slot.id === value) return; // unpickable, or already selected
    onChange(slot.id, `${d.weekday}, ${d.display}`);
  };

  return (
    <div>
      <div className="date-pills">
        {days.map((d) => {
          const pickable = byDate[d.iso].length > 0;
          const isActive = d.iso === selectedDay?.iso;
          return (
            <button
              key={d.iso}
              type="button"
              className={`date-pill${isActive ? ' is-active' : ''}`}
              disabled={!pickable}
              onClick={() => pickDay(d)}
            >
              <span className="m">{d.weekday}</span>
              <span className="d">{d.dayNum}</span>
              <span className="m">{d.month}</span>
              {isActive && <span aria-hidden="true" style={{ marginLeft: 4 }}>✓</span>}
            </button>
          );
        })}
      </div>

      {selectedDay && selectedSlot && (
        <div className="note-fresh" style={{ marginTop: 16 }}>
          <Check />
          <span>
            Избра: {selectedDay.weekday}, {selectedDay.display}
            {selectedSlot.customerNote && (
              <>
                <br />
                {selectedSlot.customerNote}
              </>
            )}
            {selectedSlot.remaining != null && (
              <>
                <br />
                Остават {selectedSlot.remaining} места
              </>
            )}
          </span>
        </div>
      )}
    </div>
  );
}
