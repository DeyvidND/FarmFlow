'use client';

import { useEffect, useState } from 'react';
import { formatTimeDigits, normalizeHHMM } from './delivery-window-shift';

/**
 * 24-hour time text input. Replaces the native `<input type="time">` on the
 * route screens: that control renders in the DEVICE locale's clock format, so
 * a phone set to 12-hour time showed '03:30 PM' next to our static 24h texts
 * ('–16:10') and operators read the window as broken. A plain text input with
 * a digits mask always displays 'HH:MM' 24h.
 *
 * Semi-controlled: `value` is the persisted time; the draft lives here while
 * typing. On blur (or Enter) the draft normalizes ('1530'/'930' → '15:30' /
 * '09:30'); a valid change fires `onCommit(normalized)`, anything else quietly
 * reverts to `value` — the same revert contract the old inputs had.
 */
export function TimeInput24({
  value,
  onCommit,
  ariaLabel,
  className,
  disabled,
}: {
  value: string;
  onCommit: (next: string) => void;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  // Resync after a save/refresh changed the persisted time under us.
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const norm = normalizeHHMM(draft);
    if (norm && norm !== value) {
      setDraft(norm);
      onCommit(norm);
      return;
    }
    setDraft(value); // invalid or unchanged → revert to the persisted time
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder="ЧЧ:ММ"
      maxLength={5}
      value={draft}
      disabled={disabled}
      onChange={(e) => setDraft(formatTimeDigits(e.target.value))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      aria-label={ariaLabel}
      className={className}
    />
  );
}
