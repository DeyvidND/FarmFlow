'use client';

/**
 * Quantity stepper — React port of the template's `.stepper` + `bindSteppers`.
 * Controlled; clamps at `min` (default 1).
 */
export function QtyStepper({
  value,
  onChange,
  min = 1,
  ariaLabel = 'Количество',
}: {
  value: number;
  onChange: (next: number) => void;
  min?: number;
  ariaLabel?: string;
}) {
  const set = (n: number) => onChange(Math.max(min, n));
  return (
    <div className="stepper" aria-label={ariaLabel}>
      <button type="button" data-dir="down" aria-label="по-малко" onClick={() => set(value - 1)}>
        −
      </button>
      <input
        type="number"
        value={value}
        min={min}
        inputMode="numeric"
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          set(Number.isNaN(n) ? min : n);
        }}
      />
      <button type="button" data-dir="up" aria-label="повече" onClick={() => set(value + 1)}>
        +
      </button>
    </div>
  );
}
