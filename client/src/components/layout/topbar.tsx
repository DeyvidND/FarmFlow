'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { Menu, Bell } from 'lucide-react';
import { cn, bgDateLabel } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';

/** First letters of up to two words, e.g. "Ферма Петрови" → "ФП". */
function toInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '–';
  return parts.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Табло',
  '/orders': 'Поръчки',
  '/production': 'За приготвяне днес',
  '/products': 'Продукти',
  '/farmers': 'Фермери',
  '/subcategories': 'Подкатегории',
  '/slots': 'Слотове за доставка',
  '/route': 'Маршрут за днес',
  '/articles': 'Статии',
  '/newsletters': 'Имейл клиенти',
};

function titleFor(pathname: string): string {
  const key = Object.keys(PAGE_TITLES).find((k) => pathname === k || pathname.startsWith(k + '/'));
  return key ? PAGE_TITLES[key] : 'FarmFlow';
}

interface TopbarProps {
  tenantName?: string;
  pendingCount?: number;
}

export function Topbar({ tenantName, pendingCount = 0 }: TopbarProps) {
  const pathname = usePathname();
  const openDrawer = useUiStore((s) => s.openDrawer);
  const [notifOpen, setNotifOpen] = useState(false);
  const [tenant, setTenant] = useState(tenantName ?? '');

  useEffect(() => {
    if (tenantName) return;
    let active = true;
    fetch('/api/session/me')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (active && d?.name) setTenant(d.name);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [tenantName]);

  const display = tenant || 'Ферма';

  return (
    <header className="ff-topbar sticky top-0 z-10 flex h-[var(--topbar-h)] shrink-0 items-center justify-between border-b border-ff-border bg-[rgba(251,248,241,0.85)] px-8 backdrop-blur-md max-sm:px-4">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <button
          onClick={openDrawer}
          aria-label="Меню"
          className="grid h-[42px] w-[42px] shrink-0 place-items-center rounded-[11px] border border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2 lg:hidden"
        >
          <Menu size={22} />
        </button>
        <h1 className="ff-page-title min-w-0 flex-auto overflow-hidden text-ellipsis whitespace-nowrap text-[22px] font-extrabold tracking-[-0.015em] max-sm:text-[19px]">
          {titleFor(pathname)}
        </h1>
      </div>

      <div className="flex shrink-0 items-center gap-[18px]">
        <div className="ff-tenant text-right leading-[1.2] max-sm:hidden">
          <div className="text-[14.5px] font-bold">{display}</div>
          <div className="text-[12.5px] font-semibold capitalize text-ff-muted">{bgDateLabel()}</div>
        </div>

        <div className="relative">
          <button
            onClick={() => setNotifOpen((v) => !v)}
            className="grid h-11 w-11 place-items-center rounded-xl border border-ff-border bg-ff-surface text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2"
            aria-label="Известия"
          >
            <Bell size={21} />
            {pendingCount > 0 && (
              <span className="absolute right-[9px] top-2 h-[9px] w-[9px] rounded-full border-2 border-ff-surface bg-ff-amber" />
            )}
          </button>
          {notifOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setNotifOpen(false)} />
              <div className="absolute right-0 top-[52px] z-[31] w-80 animate-ff-pop rounded-2xl border border-ff-border bg-ff-surface p-2 shadow-ff-lg">
                <div className="px-2.5 pb-2.5 pt-2 text-[13px] font-bold text-ff-muted">Известия</div>
                <NotifRow amber title={`${pendingCount} нови поръчки чакат потвърждение`} time="преди 5 мин" />
                <NotifRow title="Слот 09:00 – 10:00 е запълнен" time="преди 40 мин" />
                <NotifRow title="Ниска наличност: Малини 500 г (6 бр.)" time="преди 1 ч" />
              </div>
            </>
          )}
        </div>

        <div className="grid h-11 w-11 place-items-center rounded-xl bg-ff-green-100 text-[15px] font-extrabold text-ff-green-800">
          {toInitials(display)}
        </div>
      </div>
    </header>
  );
}

function NotifRow({ title, time, amber }: { title: string; time: string; amber?: boolean }) {
  return (
    <div className="ff-notif flex cursor-pointer gap-[11px] rounded-[11px] p-2.5 hover:bg-ff-surface-2">
      <span className={cn('mt-[5px] h-[9px] w-[9px] shrink-0 rounded-full', amber ? 'bg-ff-amber' : 'bg-ff-green-500')} />
      <div>
        <div className="text-[13.5px] font-semibold leading-[1.35] text-ff-ink">{title}</div>
        <div className="mt-0.5 text-xs text-ff-muted">{time}</div>
      </div>
    </div>
  );
}
