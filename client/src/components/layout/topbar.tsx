'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Menu, Bell, ChevronDown, Settings, BookOpen, LogOut } from 'lucide-react';
import { cn, bgDateLabel } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';
import { getDashboard, listProductOptions, listAvailabilityWindows, listReviews } from '@/lib/api-client';

/** One notification derived from live data (pending orders, full slots, low stock). */
interface Notif {
  id: string;
  title: string;
  meta: string;
  amber?: boolean;
}

const hhmm = (t: string) => t.slice(0, 5);

// The Topbar lives in the shell that wraps every panel route, so its mount effect
// would re-run loadNotifs (4 endpoints incl. the heavy /dashboard aggregate) on every
// navigation. Cache the computed feed at module scope (survives remounts) and only
// recompute when stale or on an explicit refresh (bell open). 60 s keeps it live
// enough for a badge the user reads occasionally.
const NOTIF_TTL_MS = 60_000;
let notifCache: { at: number; data: Notif[] } | null = null;
let notifInflight: Promise<Notif[]> | null = null;

/** Build the notification feed from the dashboard summary + product stock.
 *  Served from the module cache unless stale or `force`d (single-flighted). */
async function loadNotifs(force = false): Promise<Notif[]> {
  if (!force && notifCache && Date.now() - notifCache.at < NOTIF_TTL_MS) return notifCache.data;
  if (!force && notifInflight) return notifInflight;
  notifInflight = buildNotifs().then((data) => {
    notifCache = { at: Date.now(), data };
    notifInflight = null;
    return data;
  }).catch((err) => {
    notifInflight = null;
    throw err;
  });
  return notifInflight;
}

async function buildNotifs(): Promise<Notif[]> {
  const [dash, products, windows, pendingReviews] = await Promise.all([
    getDashboard().catch(() => null),
    listProductOptions().catch(() => null),
    listAvailabilityWindows().catch(() => null),
    listReviews('pending').catch(() => null),
  ]);
  const list: Notif[] = [];

  if (dash) {
    if (dash.pendingCount > 0) {
      list.push({
        id: 'pending',
        amber: true,
        title:
          dash.pendingCount === 1
            ? '1 нова поръчка чака потвърждение'
            : `${dash.pendingCount} нови поръчки чакат потвърждение`,
        meta: 'Поръчки',
      });
    }
    for (const s of dash.slots) {
      if (s.booked >= (s.capacity ?? 1)) {
        list.push({
          id: `slot-${s.id}`,
          title:
            s.timeFrom && s.timeTo
              ? `Часът ${hhmm(s.timeFrom)} – ${hhmm(s.timeTo)} е запълнен`
              : 'Денят за доставка е запълнен',
          meta: 'Часове',
        });
      }
    }
  }

  // Low-stock signal now comes from «Задай наличност» (a product without a window
  // is unlimited → never alerts). Names come from the product-options list.
  if (products && windows) {
    const nameById = new Map(products.map((p) => [p.id, [p.name, p.weight].filter(Boolean).join(' ')]));
    for (const w of windows) {
      if (w.remaining > 6) continue;
      const name = nameById.get(w.productId) ?? 'Продукт';
      const out = w.remaining === 0;
      list.push({
        id: `stock-${w.productId}`,
        amber: out,
        title: out ? `Изчерпан: ${name}` : `Ниска наличност: ${name} (${w.remaining} бр.)`,
        meta: 'Наличност',
      });
    }
  }

  if (pendingReviews && pendingReviews.items.length) {
    const n = pendingReviews.items.length;
    list.push({
      id: 'reviews-pending',
      amber: true,
      title:
        n === 1
          ? '1 отзив чака одобрение'
          : `${n}${pendingReviews.nextCursor ? '+' : ''} отзива чакат одобрение`,
      meta: 'Отзиви',
    });
  }

  return list.slice(0, 8);
}

/** First letters of up to two words, e.g. "Ферма Петрови" → "ФП". */
function toInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '–';
  return parts.slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
}

// Keep these labels identical to the sidebar nav (NAV_GROUPS in sidebar.tsx) so a
// screen reads the same name in the menu and in the top bar. Every admin route
// needs an entry — a missing one falls back to a bare "ФермериБГ".
const PAGE_TITLES: Record<string, string> = {
  '/dashboard': 'Табло',
  '/orders': 'Поръчки',
  '/production': 'Производство',
  '/route': 'Маршрут',
  '/payments': 'Плащания',
  '/stats': 'Статистика',
  '/products': 'Продукти',
  '/farmers': 'Фермери',
  '/subcategories': 'Категории',
  '/availability': 'Задай наличност',
  '/articles': 'Статии',
  '/reviews': 'Отзиви',
  '/site-media': 'Промени сайта',
  '/contacts': 'Контакти',
  '/marketing-tracking': 'Маркетинг и проследяване',
  '/newsletters': 'Имейл клиенти',
  '/setup': 'Методи и цени',
  '/delivery': 'Цени и правила за доставка',
  '/slots': 'Часове за доставка',
  '/features': 'Функции на магазина',
  '/settings': 'Настройки',
  '/help': 'Помощ',
};

function titleFor(pathname: string): string {
  const key = Object.keys(PAGE_TITLES).find((k) => pathname === k || pathname.startsWith(k + '/'));
  return key ? PAGE_TITLES[key] : 'ФермериБГ';
}

interface TopbarProps {
  tenantName?: string;
}

export function Topbar({ tenantName }: TopbarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const openDrawer = useUiStore((s) => s.openDrawer);
  const [notifOpen, setNotifOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [tenant, setTenant] = useState(tenantName ?? '');
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const notifRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  async function onLogout() {
    await fetch('/api/session/logout', { method: 'POST' }).catch(() => {});
    setMenuOpen(false);
    router.push('/login');
    router.refresh();
  }

  const refreshNotifs = useCallback((force = false) => {
    loadNotifs(force)
      .then(setNotifs)
      .catch(() => {});
  }, []);

  // On mount use the module cache (no refetch across navigations within the TTL);
  // the bell-open handler forces a live refresh.
  useEffect(() => {
    refreshNotifs();
  }, [refreshNotifs]);

  useEffect(() => {
    if (!notifOpen) return;
    const handler = (e: MouseEvent) => {
      if (!notifRef.current?.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [notifOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Close the account menu on navigation so it never lingers over a new page.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

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
            onClick={() => {
              setNotifOpen((v) => !v);
              if (!notifOpen) refreshNotifs(true);
            }}
            className="grid h-11 w-11 place-items-center rounded-xl border border-ff-border bg-ff-surface text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2"
            aria-label="Известия"
          >
            <Bell size={21} />
            {notifs.length > 0 && (
              <span className="absolute right-[9px] top-2 h-[9px] w-[9px] rounded-full border-2 border-ff-surface bg-ff-amber" />
            )}
          </button>
          {notifOpen && (
            <div ref={notifRef} className="fixed inset-x-3 top-[72px] z-[31] max-h-[70vh] min-h-[240px] overflow-y-auto animate-ff-pop rounded-2xl border border-ff-border bg-ff-surface p-2 shadow-ff-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-[52px] sm:max-h-none sm:min-h-0 sm:w-80">
              <div className="px-2.5 pb-2.5 pt-2 text-[13px] font-bold text-ff-muted">Известия</div>
              {notifs.length === 0 ? (
                <div className="px-2.5 pb-3 pt-1 text-[13.5px] text-ff-muted">Няма нови известия.</div>
              ) : (
                notifs.map((n) => (
                  <NotifRow key={n.id} amber={n.amber} title={n.title} time={n.meta} />
                ))
              )}
            </div>
          )}
        </div>

        <div className="relative" ref={menuRef}>
          <button
            onClick={() => setMenuOpen((v) => !v)}
            aria-label="Профил и настройки"
            aria-expanded={menuOpen}
            className="flex items-center gap-1.5 rounded-xl pl-0.5 pr-1.5 transition-colors hover:bg-ff-surface-2"
          >
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-ff-green-100 text-[15px] font-extrabold text-ff-green-800">
              {toInitials(display)}
            </span>
            <ChevronDown
              size={16}
              className={cn('shrink-0 text-ff-muted transition-transform', menuOpen && 'rotate-180')}
            />
          </button>
          {menuOpen && (
            <div className="fixed inset-x-3 top-[72px] z-[31] animate-ff-pop rounded-2xl border border-ff-border bg-ff-surface p-2 shadow-ff-lg sm:absolute sm:inset-x-auto sm:right-0 sm:top-[52px] sm:w-60">
              <div className="truncate px-2.5 pb-2 pt-1 text-[13px] font-bold text-ff-muted">{display}</div>
              <Link
                href="/settings"
                onClick={() => setMenuOpen(false)}
                className={cn(
                  'flex items-center gap-3 rounded-[11px] px-2.5 py-2.5 text-[14.5px] font-semibold transition-colors hover:bg-ff-surface-2',
                  pathname.startsWith('/settings') ? 'text-ff-green-800' : 'text-ff-ink',
                )}
              >
                <Settings size={19} /> Настройки
              </Link>
              <Link
                href="/help"
                onClick={() => setMenuOpen(false)}
                className={cn(
                  'flex items-center gap-3 rounded-[11px] px-2.5 py-2.5 text-[14.5px] font-semibold transition-colors hover:bg-ff-surface-2',
                  pathname.startsWith('/help') ? 'text-ff-green-800' : 'text-ff-ink',
                )}
              >
                <BookOpen size={19} /> Помощ
              </Link>
              <div className="my-1 border-t border-ff-border" />
              <button
                type="button"
                onClick={onLogout}
                className="flex w-full items-center gap-3 rounded-[11px] px-2.5 py-2.5 text-left text-[14.5px] font-semibold text-ff-ink transition-colors hover:bg-ff-green-50"
              >
                <LogOut size={19} /> Изход
              </button>
            </div>
          )}
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
