'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  ClipboardList,
  CreditCard,
  ShoppingBasket,
  Package,
  Users,
  Tags,
  CalendarDays,
  Truck,
  Route as RouteIcon,
  Newspaper,
  Mail,
  Leaf,
  Lock,
  LogOut,
  Settings,
  BookOpen,
  ChevronDown,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Screen needs an active subscription — flagged with a lock when inactive. */
  gated?: boolean;
}

interface NavGroup {
  title: string;
  items: NavItem[];
  /** Set-up-once groups fold away by default to keep the everyday list short. */
  collapsible?: boolean;
}

/** Home/overview — stands alone above the grouped sections. */
const HOME: NavItem = { href: '/dashboard', label: 'Табло', Icon: LayoutDashboard };

// Grouped by intent — everyday work (sell · fulfil) stays open; set-up-once
// groups (catalog · marketing) fold away so the list doesn't overwhelm.
export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Продажби',
    items: [
      { href: '/orders', label: 'Поръчки', Icon: ClipboardList },
      { href: '/payments', label: 'Плащания', Icon: CreditCard },
    ],
  },
  {
    title: 'Доставка',
    items: [
      { href: '/production', label: 'Производство', Icon: ShoppingBasket, gated: true },
      { href: '/route', label: 'Маршрут', Icon: RouteIcon, gated: true },
      { href: '/slots', label: 'Слотове', Icon: CalendarDays, gated: true },
      { href: '/delivery', label: 'Доставка', Icon: Truck },
    ],
  },
  {
    title: 'Каталог',
    collapsible: true,
    items: [
      { href: '/products', label: 'Продукти', Icon: Package },
      { href: '/farmers', label: 'Фермери', Icon: Users },
      { href: '/subcategories', label: 'Подкатегории', Icon: Tags },
    ],
  },
  {
    title: 'Маркетинг',
    collapsible: true,
    items: [
      { href: '/articles', label: 'Статии', Icon: Newspaper, gated: true },
      { href: '/newsletters', label: 'Имейл клиенти', Icon: Mail },
    ],
  },
];

/** Flattened list (back-compat for any consumer that wants every item). */
export const NAV: NavItem[] = [HOME, ...NAV_GROUPS.flatMap((g) => g.items)];

const OPEN_STORAGE_KEY = 'ff-nav-open';

function Logo({ size = 38 }: { size?: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center rounded-[11px] bg-ff-green-700 text-[#EAF1E4] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
      style={{ width: size, height: size }}
    >
      <Leaf size={size * 0.58} strokeWidth={1.9} />
    </div>
  );
}

export function Sidebar({
  pendingCount = 0,
  subscriptionActive = true,
}: {
  pendingCount?: number;
  subscriptionActive?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const closeDrawer = useUiStore((s) => s.closeDrawer);

  // Persisted manual open/closed state for collapsible groups. Starts empty so
  // SSR + first client render agree (no hydration mismatch); restored on mount.
  const [openState, setOpenState] = useState<Record<string, boolean>>({});
  useEffect(() => {
    try {
      const raw = localStorage.getItem(OPEN_STORAGE_KEY);
      if (raw) setOpenState(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');
  const groupHasActive = (g: NavGroup) => g.items.some((i) => isActive(i.href));
  // A group is shown when it isn't collapsible, when it holds the active page, or
  // when the farmer has expanded it. Collapsible groups default to folded.
  const isGroupOpen = (g: NavGroup) =>
    !g.collapsible || groupHasActive(g) || (openState[g.title] ?? false);

  function toggleGroup(title: string) {
    setOpenState((prev) => {
      const next = { ...prev, [title]: !(prev[title] ?? false) };
      try {
        localStorage.setItem(OPEN_STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  async function onLogout() {
    await fetch('/api/session/logout', { method: 'POST' }).catch(() => {});
    closeDrawer();
    router.push('/login');
    router.refresh();
  }

  const renderItem = (item: NavItem) => {
    const on = isActive(item.href);
    const locked = !!item.gated && !subscriptionActive;
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={closeDrawer}
        data-on={on}
        title={locked ? 'Изисква активен абонамент' : undefined}
        className={cn(
          'ff-nav-item flex items-center gap-[13px] rounded-[10px] border-l-[3px] px-[13px] py-[11px] text-[15px] transition-colors',
          on
            ? 'border-ff-green-600 bg-ff-green-50 font-bold text-ff-green-800'
            : 'border-transparent font-semibold text-ff-ink-2 hover:bg-ff-green-50 hover:text-ff-ink',
          locked && 'opacity-55',
        )}
      >
        <item.Icon size={21} strokeWidth={on ? 2 : 1.8} />
        <span className="flex-1">{item.label}</span>
        {locked && <Lock size={14} className="shrink-0 text-ff-muted-2" />}
        {item.href === '/orders' && pendingCount > 0 && (
          <span
            className={cn(
              'grid h-[21px] min-w-[21px] place-items-center rounded-full px-1.5 text-xs font-extrabold',
              on ? 'bg-ff-green-100 text-ff-green-700' : 'bg-ff-amber-soft text-ff-amber-600',
            )}
          >
            {pendingCount}
          </span>
        )}
      </Link>
    );
  };

  return (
    <aside
      data-open={drawerOpen}
      className={cn(
        'ff-sidebar relative z-[5] flex h-full w-[var(--sidebar-w)] shrink-0 flex-col border-r border-ff-border bg-ff-surface px-4 pb-[18px] pt-[22px]',
        // off-canvas drawer below lg
        'max-lg:fixed max-lg:inset-y-0 max-lg:left-0 max-lg:z-[60] max-lg:-translate-x-full max-lg:shadow-ff-lg max-lg:transition-transform max-lg:duration-300 max-lg:[transition-timing-function:cubic-bezier(.32,.72,0,1)]',
        'max-lg:data-[open=true]:translate-x-0',
      )}
    >
      <div className="flex shrink-0 items-center gap-[11px] px-1.5 pb-[18px] pt-0.5">
        <Logo />
        <div className="leading-[1.1]">
          <div className="font-display text-[19px] font-extrabold tracking-[-0.01em]">FarmFlow</div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-ff-muted">Управление на фермата</div>
        </div>
      </div>

      <nav className="ff-nav-scroll mt-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5 [scrollbar-width:thin]">
        {/* Home — always on top, no group header */}
        <div className="flex flex-col gap-1">{renderItem(HOME)}</div>

        {NAV_GROUPS.map((group) => {
          const open = isGroupOpen(group);
          return (
            <div key={group.title} className="flex flex-col gap-1">
              {group.collapsible ? (
                <button
                  type="button"
                  onClick={() => toggleGroup(group.title)}
                  className="flex items-center justify-between rounded-[8px] px-[13px] pb-0.5 pt-1 text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2 transition-colors hover:text-ff-muted"
                  aria-expanded={open}
                >
                  <span>{group.title}</span>
                  <ChevronDown
                    size={13}
                    className={cn('shrink-0 transition-transform', !open && '-rotate-90')}
                  />
                </button>
              ) : (
                <div className="px-[13px] pb-0.5 pt-1 text-[10.5px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2">
                  {group.title}
                </div>
              )}
              {open && group.items.map(renderItem)}
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 pt-4">
        <Link
          href="/help"
          onClick={closeDrawer}
          data-on={pathname === '/help' || pathname.startsWith('/help/')}
          className={cn(
            'ff-nav-item flex items-center gap-[13px] rounded-[10px] border-l-[3px] px-[13px] py-2.5 text-[14.5px] transition-colors',
            pathname === '/help' || pathname.startsWith('/help/')
              ? 'border-ff-green-600 bg-ff-green-50 font-bold text-ff-green-800'
              : 'border-transparent font-semibold text-ff-muted hover:bg-ff-green-50 hover:text-ff-ink',
          )}
        >
          <BookOpen
            size={20}
            strokeWidth={pathname === '/help' || pathname.startsWith('/help/') ? 2 : 1.8}
          />
          Документация
        </Link>
        <Link
          href="/settings"
          onClick={closeDrawer}
          data-on={pathname === '/settings' || pathname.startsWith('/settings/')}
          className={cn(
            'ff-nav-item mt-1.5 flex items-center gap-[13px] rounded-[10px] border-l-[3px] px-[13px] py-2.5 text-[14.5px] transition-colors',
            pathname === '/settings' || pathname.startsWith('/settings/')
              ? 'border-ff-green-600 bg-ff-green-50 font-bold text-ff-green-800'
              : 'border-transparent font-semibold text-ff-muted hover:bg-ff-green-50 hover:text-ff-ink',
          )}
        >
          <Settings size={20} strokeWidth={pathname === '/settings' || pathname.startsWith('/settings/') ? 2 : 1.8} />
          Настройки
        </Link>
        <button
          type="button"
          onClick={onLogout}
          className="ff-nav-item mt-1.5 flex w-full items-center gap-[13px] rounded-[10px] px-[13px] py-2.5 text-left text-[14.5px] font-semibold text-ff-muted hover:bg-ff-green-50 hover:text-ff-ink"
        >
          <LogOut size={20} /> Изход
        </button>
      </div>
    </aside>
  );
}
