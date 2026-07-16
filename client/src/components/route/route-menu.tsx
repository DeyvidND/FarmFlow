'use client';

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

const cn = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

const MENU_W = 248;

export type RouteMenuItem = {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  disabled?: boolean;
  /** Small green tag after the label (e.g. „· ръчен"). */
  tag?: string;
};

/**
 * A tiny dropdown menu for the route toolbar — the button-count reducer.
 * Groups low-frequency actions (planning, navigation choice, finish-all) behind
 * one trigger instead of spreading each as its own top-level pill.
 *
 * The panel is PORTALED to <body> with fixed positioning measured from the
 * trigger: the stop-list card that hosts the „Навигация"/„⋯" menus is
 * `overflow-hidden` (for its rounded corners + inner scroll), which would clip
 * an in-flow absolute dropdown. Closes on outside click, item select, and any
 * scroll (so the fixed panel never drifts from its anchor).
 */
export function RouteMenu({
  label,
  icon,
  items,
  align = 'right',
  triggerClassName,
  iconOnly = false,
  title,
}: {
  label: string;
  icon?: ReactNode;
  items: RouteMenuItem[];
  align?: 'left' | 'right';
  /** Full override of the trigger's look so it can match either toolbar's pills. */
  triggerClassName?: string;
  /** Render just the icon (used for the „⋯" overflow). */
  iconOnly?: boolean;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left?: number; right?: number }>({ top: 0 });

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const el = btnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const top = r.bottom + 6;
      if (align === 'left') {
        const left = Math.min(r.left, window.innerWidth - MENU_W - 8);
        setPos({ top, left: Math.max(8, left) });
      } else {
        setPos({ top, right: Math.max(8, window.innerWidth - r.right) });
      }
    };
    place();
    const close = () => setOpen(false);
    window.addEventListener('resize', place);
    // capture=true so a scroll on ANY ancestor (e.g. the stop list) closes it
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', close, true);
    };
  }, [open, align]);

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        title={title}
        aria-label={iconOnly ? title ?? label : undefined}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'inline-flex items-center gap-1.5 font-bold transition',
          triggerClassName ??
            'rounded-[9px] border border-ff-border bg-ff-surface px-[11px] py-[7px] text-[13px] text-ff-ink-2 hover:bg-ff-surface-2',
        )}
      >
        {icon}
        {!iconOnly && label}
        {!iconOnly && (
          <ChevronDown size={15} className={cn('text-ff-muted transition-transform', open && 'rotate-180')} />
        )}
      </button>
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[85]" onClick={() => setOpen(false)} />
            <div
              role="menu"
              style={{ top: pos.top, left: pos.left, right: pos.right, minWidth: MENU_W }}
              className="animate-ff-pop fixed z-[86] rounded-xl border border-ff-border bg-ff-surface p-1.5 shadow-ff-lg"
            >
              {items.map((it, i) => (
                <button
                  key={i}
                  type="button"
                  role="menuitem"
                  disabled={it.disabled}
                  onClick={() => {
                    if (it.disabled) return;
                    setOpen(false);
                    it.onSelect();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-[13.5px] font-bold text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {it.icon && <span className="shrink-0 text-ff-muted">{it.icon}</span>}
                  <span className="flex-1">
                    {it.label}
                    {it.tag && <span className="ml-1 font-bold text-ff-green-700">{it.tag}</span>}
                  </span>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </div>
  );
}
