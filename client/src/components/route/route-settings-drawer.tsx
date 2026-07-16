'use client';

import { useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, Clock, Home, MapPin, Users, X } from 'lucide-react';
import type { RouteEndMode } from '@/lib/types';

const cn = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

type EndOption = { mode: RouteEndMode; label: string; Icon: typeof Home; hint: string };

/**
 * The route's set-once config, collapsed behind one „Настройки" entry point
 * (audit P1). Base address, route end, courier split / day board, courier homes
 * and delivery windows all persist as tenant defaults, so they don't earn
 * permanent top-of-screen real estate — one drawer, grouped, elder-first big
 * rows. Each row opens the feature's existing modal (rendered by the parent over
 * this drawer); the drawer stays mounted behind so the farmer lands back here.
 */
export function RouteSettingsDrawer({
  baseAddress,
  endOptions,
  couriers,
  initialCourierPos,
  onSetEndAt,
  courierCount,
  onSetCouriers,
  boardActive,
  boardLegCount,
  onOpenLocation,
  onOpenHomes,
  onOpenWindows,
  onOpenBoard,
  onClose,
}: {
  baseAddress: string | null;
  endOptions: EndOption[];
  /** Per-courier (tab-order) end config for the pager. Length 1 = single courier. */
  couriers: { label: string; endMode: RouteEndMode }[];
  /** Which courier the end pager opens on (usually the active tab). */
  initialCourierPos: number;
  onSetEndAt: (pos: number, mode: RouteEndMode) => void;
  courierCount: number;
  onSetCouriers: (n: number) => void;
  boardActive: boolean;
  boardLegCount: number;
  onOpenLocation: () => void;
  onOpenHomes: () => void;
  onOpenWindows: () => void;
  onOpenBoard: () => void;
  onClose: () => void;
}) {
  const multiCourier = couriers.length > 1;
  const [endPos, setEndPos] = useState(() =>
    Math.min(Math.max(initialCourierPos, 0), Math.max(couriers.length - 1, 0)),
  );
  const cur = couriers[endPos] ?? couriers[0];
  const curHint = endOptions.find((o) => o.mode === cur?.endMode)?.hint ?? '';
  return (
    <>
      <div onClick={onClose} className="animate-ff-fade fixed inset-0 z-[78] bg-[rgba(30,28,15,0.32)]" />
      <aside
        className="animate-ff-slide-in fixed right-0 top-0 z-[79] flex h-full w-[420px] max-w-[94vw] flex-col bg-ff-surface shadow-ff-lg"
        role="dialog"
        aria-label="Настройки на маршрута"
      >
        <div className="flex items-center justify-between border-b border-ff-border-2 px-5 py-4">
          <h2 className="text-[17px] font-extrabold text-ff-ink">Настройки на маршрута</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Затвори"
            className="grid h-9 w-9 place-items-center rounded-lg border border-ff-border bg-ff-surface-2 text-ff-ink-2 hover:text-ff-ink"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <SectionLabel>База и край</SectionLabel>
          <Row
            icon={<MapPin size={18} />}
            label="Локация на базата"
            subtitle={baseAddress ?? 'Не е зададена — задай, за да тръгне маршрутът'}
            onClick={onOpenLocation}
          />

          <div className="mt-3 rounded-xl border border-ff-border bg-ff-surface-2 p-3">
            <div className="mb-1.5 flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-bold text-ff-ink-2">
                Край на маршрута{multiCourier ? ` · ${cur?.label ?? ''}` : ''}
              </span>
              {multiCourier && (
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEndPos((p) => Math.max(0, p - 1))}
                    disabled={endPos === 0}
                    aria-label="Предишен куриер"
                    className="grid h-7 w-7 place-items-center rounded-lg border border-ff-border bg-ff-surface text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:opacity-40"
                  >
                    <ChevronLeft size={15} />
                  </button>
                  <span className="min-w-[34px] text-center text-[12px] font-bold tabular-nums text-ff-muted">
                    {endPos + 1}/{couriers.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setEndPos((p) => Math.min(couriers.length - 1, p + 1))}
                    disabled={endPos === couriers.length - 1}
                    aria-label="Следващ куриер"
                    className="grid h-7 w-7 place-items-center rounded-lg border border-ff-border bg-ff-surface text-ff-ink-2 transition hover:bg-ff-surface-2 disabled:opacity-40"
                  >
                    <ChevronRight size={15} />
                  </button>
                </div>
              )}
            </div>
            <div className="flex gap-1 rounded-xl border border-ff-border bg-ff-surface p-1">
              {endOptions.map(({ mode, label, Icon }) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onSetEndAt(endPos, mode)}
                  className={cn(
                    'inline-flex flex-1 items-center justify-center gap-1.5 rounded-[8px] px-2.5 py-2 text-[12.5px] font-bold transition',
                    cur?.endMode === mode
                      ? 'bg-ff-green-100 text-ff-green-800'
                      : 'text-ff-ink-2 hover:bg-ff-surface',
                  )}
                >
                  <Icon size={14} /> {label}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-ff-muted">{curHint}</p>
            {multiCourier && (
              <p className="mt-1 text-[11px] text-ff-muted">
                Всеки куриер може да има различен край — превърти със стрелките.
              </p>
            )}
          </div>

          <SectionLabel className="mt-5">Куриери</SectionLabel>
          <Row
            icon={<Users size={18} />}
            label="Куриери за деня"
            subtitle={
              boardActive
                ? `Табло активно · ${boardLegCount} ${boardLegCount === 1 ? 'курс' : 'курса'}`
                : 'Задай кой доставя днес и кой курс кара'
            }
            highlight={boardActive}
            onClick={onOpenBoard}
          />
          {!boardActive && (
            <label className="mt-3 flex items-center justify-between gap-2 rounded-xl border border-ff-border bg-ff-surface-2 px-3.5 py-3 text-[13px] font-bold text-ff-ink-2">
              Раздели маршрута на
              <select
                value={courierCount}
                onChange={(e) => onSetCouriers(parseInt(e.target.value, 10))}
                aria-label="Брой куриери"
                className="rounded-md border border-ff-border bg-ff-surface px-2 py-1 text-[13px] font-bold text-ff-ink outline-none"
              >
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n} {n === 1 ? 'куриер' : 'куриера'}
                  </option>
                ))}
              </select>
            </label>
          )}
          <Row
            className="mt-3"
            icon={<Home size={18} />}
            label="Домове на куриерите"
            subtitle="Къде свършва всеки куриер (по избор)"
            onClick={onOpenHomes}
          />

          <SectionLabel className="mt-5">Доставка</SectionLabel>
          <Row
            icon={<Clock size={18} />}
            label="Часове за доставка"
            subtitle="Времеви прозорци + известия до клиентите"
            onClick={onOpenWindows}
          />
        </div>
      </aside>
    </>
  );
}

function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mb-2 text-[11.5px] font-extrabold uppercase tracking-[0.04em] text-ff-muted', className)}>
      {children}
    </div>
  );
}

function Row({
  icon,
  label,
  subtitle,
  onClick,
  highlight,
  className,
}: {
  icon: ReactNode;
  label: string;
  subtitle: string;
  onClick: () => void;
  highlight?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl border px-3.5 py-3 text-left transition',
        highlight
          ? 'border-ff-green-500 bg-ff-green-50'
          : 'border-ff-border bg-ff-surface hover:bg-ff-surface-2',
        className,
      )}
    >
      <span
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-lg',
          highlight ? 'bg-ff-green-100 text-ff-green-800' : 'bg-ff-surface-2 text-ff-ink-2',
        )}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-bold text-ff-ink">{label}</span>
        <span className="block truncate text-[12px] text-ff-muted">{subtitle}</span>
      </span>
      <ChevronRight size={17} className="shrink-0 text-ff-muted" />
    </button>
  );
}
