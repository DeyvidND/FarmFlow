'use client';

/**
 * Shared primitives for the store control panels (`/setup`, `/features`). A panel
 * is a switchboard: each card is icon + title + a plain-Bulgarian explanation +
 * an on/off toggle, with an optional «Настрой →» link to the page that holds the
 * feature's detailed configuration. No heavy config lives in the cards.
 */
import * as React from 'react';
import Link from 'next/link';
import { ExternalLink, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';

/** A titled group of toggle cards. */
export function CardGroup({
  icon: Icon,
  title,
  desc,
  children,
}: {
  icon: LucideIcon;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-[14px] border border-ff-border bg-ff-surface p-5 shadow-ff-sm">
      <div className="mb-4 flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-ff-green-100 text-ff-green-700">
          <Icon size={22} />
        </span>
        <div>
          <h2 className="font-display text-[16px] font-extrabold tracking-[-0.01em] text-ff-ink">
            {title}
          </h2>
          <p className="mt-0.5 max-w-[560px] text-[13px] leading-snug text-ff-ink-2">{desc}</p>
        </div>
      </div>
      <div className="flex flex-col gap-2.5">{children}</div>
    </section>
  );
}

/**
 * One switchboard row. Pass `onToggle` for an on/off card, or `headerAction`
 * (e.g. a status-driven button) when the state isn't a simple boolean the farmer
 * flips here. `configLink` adds a «Настрой →» deep-link shown only when `on`.
 */
export function ToggleCard({
  icon: Icon,
  title,
  desc,
  on,
  onToggle,
  badge,
  headerAction,
  configLink,
}: {
  icon: LucideIcon;
  title: string;
  desc: React.ReactNode;
  on: boolean;
  onToggle?: (v: boolean) => void;
  badge?: React.ReactNode;
  headerAction?: React.ReactNode;
  /** One «Настрой →» deep-link, or several when the card configures in more than
   *  one place (e.g. courier: connect in „Доставки" + pricing rules here). */
  configLink?: { href: string; label: string } | ReadonlyArray<{ href: string; label: string }>;
}) {
  const configLinks = configLink
    ? Array.isArray(configLink)
      ? configLink
      : [configLink]
    : [];
  return (
    <div
      className={cn(
        'overflow-hidden rounded-xl border transition-colors',
        on ? 'border-ff-green-100 bg-ff-green-50' : 'border-ff-border bg-ff-surface-2',
      )}
    >
      <div className="flex items-center gap-3 px-[15px] py-3.5">
        <span
          className={cn(
            'grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border-2',
            on ? 'bg-ff-green-100 text-ff-green-700' : 'bg-ff-surface text-ff-muted',
          )}
        >
          <Icon size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[14.5px] font-extrabold text-ff-ink">
            {title}
            {badge}
          </div>
          <div className="mt-0.5 max-w-[560px] text-[12.5px] leading-snug text-ff-muted">{desc}</div>
        </div>
        {headerAction}
        {onToggle && <ToggleSwitch checked={on} onChange={onToggle} />}
      </div>
      {on && configLinks.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-ff-green-100 bg-ff-surface px-[15px] py-2.5">
          {configLinks.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="inline-flex items-center gap-1.5 text-[13px] font-bold text-ff-green-700 hover:underline"
            >
              <ExternalLink size={14} /> {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Sticky unsaved-changes bar shared by the panels. */
export function SaveBar({
  saving,
  onSave,
  onDiscard,
}: {
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="animate-ff-fade-up fixed inset-x-0 bottom-0 z-30 flex items-center justify-center gap-3.5 bg-ff-green-950 px-5 py-3 text-white shadow-[0_-8px_30px_rgba(0,0,0,0.18)]">
      <span className="inline-flex items-center gap-2 text-[14px] font-bold">
        <span className="animate-ff-pulse h-2 w-2 rounded-full bg-ff-amber" />
        Имаш незапазени промени
      </span>
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onDiscard}
          disabled={saving}
          className="rounded-sm border border-white/20 bg-white/10 px-4 py-2 text-[14px] font-bold text-white transition-colors hover:bg-white/20 disabled:opacity-50"
        >
          Отмени
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className="inline-flex items-center gap-1.5 rounded-sm bg-ff-amber px-4 py-2 text-[14px] font-extrabold text-[#3a2a08] transition-colors hover:brightness-105 disabled:opacity-50"
        >
          {saving ? 'Записване…' : 'Запази промените'}
        </button>
      </div>
    </div>
  );
}
