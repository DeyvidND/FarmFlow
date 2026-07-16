'use client';

import { useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

const cn = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

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
 * one trigger instead of spreading each as its own top-level pill. Closes on
 * outside click via a transparent full-screen catcher (no listener cleanup),
 * and on any item select.
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
  return (
    <div className="relative">
      <button
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
      {open && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => setOpen(false)} />
          <div
            role="menu"
            className={cn(
              'animate-ff-pop absolute z-[61] mt-1.5 min-w-[248px] rounded-xl border border-ff-border bg-ff-surface p-1.5 shadow-ff-lg',
              align === 'right' ? 'right-0' : 'left-0',
            )}
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
        </>
      )}
    </div>
  );
}
