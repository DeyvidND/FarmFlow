'use client';

import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const KEY = 'ff_a11y_large';

/**
 * „Едър текст" — one toggle that raises every sub-13px secondary text in the
 * panel (see globals.css [data-a11y-large]). A pure display preference: stored
 * in localStorage (no cross-device sync needed), applied pre-paint by the
 * inline script in app/layout.tsx so there's no flash on load.
 */
export function A11yToggle({ className }: { className?: string }) {
  const [on, setOn] = useState(false);

  useEffect(() => {
    setOn(document.documentElement.hasAttribute('data-a11y-large'));
  }, []);

  function toggle() {
    const next = !on;
    setOn(next);
    if (next) {
      document.documentElement.setAttribute('data-a11y-large', '1');
      localStorage.setItem(KEY, '1');
    } else {
      document.documentElement.removeAttribute('data-a11y-large');
      localStorage.setItem(KEY, '0');
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      aria-label="Едър текст"
      title="Едър текст"
      className={cn(
        'grid h-11 w-11 shrink-0 place-items-center rounded-xl border text-[15px] font-extrabold transition-colors',
        on
          ? 'border-ff-green-200 bg-ff-green-50 text-ff-green-800'
          : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2',
        className,
      )}
    >
      Аа
    </button>
  );
}
