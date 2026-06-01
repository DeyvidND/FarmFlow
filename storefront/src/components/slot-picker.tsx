'use client';

/**
 * Delivery slot picker — React port of the slot module in `checkout.html`.
 * Date pills span the next 7 days (today..+6); each day loads its available
 * slots from `GET /public/:slug/slots?date=`. Full/booked slots never come back
 * from the API, so there is no client-side "disabled" state. When the whole
 * window is empty (farm delivery disabled, or no capacity) the picker renders
 * nothing and reports it via `onAvailabilityResolved`, so the checkout can drop
 * the slot requirement.
 *
 * Fully controlled: the selected `slotId` lives in the parent; this component
 * only surfaces picks through `onChange`.
 */
import { useEffect, useMemo, useState } from 'react';
import { getSlots, resolveSlug, type PublicSlot } from '@/lib/api';
import { Check } from './icons';

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд']; // Mon-first
const MONTHS = ['яну', 'фев', 'мар', 'апр', 'май', 'юни', 'юли', 'авг', 'сеп', 'окт', 'ное', 'дек'];

interface DayPill {
  iso: string; // YYYY-MM-DD (UTC — lines up with the seeded slot window)
  dayNum: number;
  weekday: string;
  month: string;
  display: string; // "2 юни"
}

/** Next 7 calendar days starting today, in UTC so the iso strings match the seed. */
function buildWindow(): DayPill[] {
  const base = new Date();
  base.setUTCHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
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
  const [activeIso, setActiveIso] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      // One fetch per day in the window (public API takes a single ?date=).
      // Per-call catch keeps one bad date from blanking the whole picker.
      const results = await Promise.all(
        days.map((d) => getSlots(slug, d.iso).catch(() => [] as PublicSlot[])),
      );
      if (!alive) return;
      const map: Record<string, PublicSlot[]> = {};
      days.forEach((d, i) => {
        map[d.iso] = results[i];
      });
      const firstWithSlots = days.find((d) => map[d.iso].length > 0) ?? null;
      setByDate(map);
      setActiveIso(firstWithSlots?.iso ?? null);
      onAvailabilityResolved?.(firstWithSlots != null);
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
        Зареждане на свободни часове…
      </p>
    );
  }

  // Nothing free anywhere → hide the module (delivery off or fully booked).
  const hasAny = days.some((d) => byDate[d.iso].length > 0);
  if (!hasAny) return null;

  const activeDay = days.find((d) => d.iso === activeIso) ?? null;
  const activeSlots = activeIso ? byDate[activeIso] : [];
  const selectedSlot = activeSlots.find((s) => s.id === value) ?? null;

  const pickDate = (iso: string) => {
    if (iso === activeIso) return;
    setActiveIso(iso);
    onChange(null, null); // switching day clears the chosen slot (template behavior)
  };

  const pickSlot = (slot: PublicSlot) => {
    onChange(slot.id, `${activeDay?.display ?? ''}, ${slot.startTime}–${slot.endTime}`);
  };

  return (
    <div>
      <div className="date-pills">
        {days.map((d) => (
          <button
            key={d.iso}
            type="button"
            className={`date-pill${d.iso === activeIso ? ' is-active' : ''}`}
            onClick={() => pickDate(d.iso)}
          >
            <span className="m">{d.weekday}</span>
            <span className="d">{d.dayNum}</span>
            <span className="m">{d.month}</span>
          </button>
        ))}
      </div>

      <div className="slots" style={{ marginTop: 16 }}>
        {activeSlots.length === 0 ? (
          <p className="muted" style={{ fontSize: 14, gridColumn: '1 / -1' }}>
            Няма свободни часове за този ден.
          </p>
        ) : (
          activeSlots.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`slot${s.id === value ? ' is-active' : ''}`}
              onClick={() => pickSlot(s)}
            >
              {s.startTime}–{s.endTime}
            </button>
          ))
        )}
      </div>

      {selectedSlot && activeDay && (
        <div className="note-fresh" style={{ marginTop: 16 }}>
          <Check /> Избра: {activeDay.display}, {selectedSlot.startTime}–{selectedSlot.endTime}
        </div>
      )}
    </div>
  );
}
