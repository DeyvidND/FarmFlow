'use client';

/** The design's bespoke pill toggle (components.jsx Toggle) — not radix. */
export function ToggleSwitch({
  checked,
  onChange,
  small,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  small?: boolean;
  disabled?: boolean;
}) {
  const w = small ? 38 : 46;
  const h = small ? 22 : 26;
  const k = h - 6;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!checked);
      }}
      className="relative shrink-0 rounded-full transition-colors disabled:opacity-50"
      style={{ width: w, height: h, padding: 3, background: checked ? 'var(--ff-green-600)' : '#D9D2C2' }}
    >
      <span
        className="absolute rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.2)] transition-[left] duration-200"
        style={{ top: 3, left: checked ? w - k - 3 : 3, width: k, height: k }}
      />
    </button>
  );
}
