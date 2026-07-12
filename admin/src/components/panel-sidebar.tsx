'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LayoutDashboard,
  Users,
  Sprout,
  Truck,
  AlertTriangle,
  Activity,
  LineChart,
  Mail,
  CreditCard,
  ScrollText,
  Settings,
  LogOut,
  Leaf,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';

export interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
}

/** Home/overview — stands alone above the grouped sections. */
export const HOME: NavItem = { href: '/dashboard', label: 'Табло', Icon: LayoutDashboard };

/** Grouped by operator intent: who's on the platform · day-to-day ops ·
 *  money + records. Mirrors the farmer app's site-nav spine so the two panels
 *  feel like one product — replaces the old overflow-scroll top rail. */
export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Ферми и хора',
    items: [
      { href: '/tenants', label: 'Ферми', Icon: Users },
      { href: '/producers', label: 'Производители', Icon: Sprout },
    ],
  },
  {
    title: 'Операции',
    items: [
      { href: '/delivery', label: 'Доставка', Icon: Truck },
      { href: '/problems', label: 'Проблеми', Icon: AlertTriangle },
      { href: '/health', label: 'Здраве', Icon: Activity },
    ],
  },
  {
    title: 'Анализ и пари',
    items: [
      { href: '/insights', label: 'Анализ', Icon: LineChart },
      { href: '/email-billing', label: 'Имейл сметки', Icon: Mail },
      { href: '/stripe', label: 'Stripe', Icon: CreditCard },
      { href: '/audit', label: 'Одит', Icon: ScrollText },
    ],
  },
];

/** Flat list — used by the topbar to resolve the current page title. */
export const ALL_NAV: NavItem[] = [
  HOME,
  ...NAV_GROUPS.flatMap((g) => g.items),
  { href: '/settings', label: 'Настройки', Icon: Settings },
];

export function currentTitle(pathname: string): string {
  // Longest matching prefix wins (so /tenants/[id] resolves to «Ферми»).
  const hit = ALL_NAV.filter((n) => pathname === n.href || pathname.startsWith(n.href + '/')).sort(
    (a, b) => b.href.length - a.href.length,
  )[0];
  return hit?.label ?? 'Платформа';
}

export function PanelSidebar({ onNavigate, onLogout }: { onNavigate?: () => void; onLogout: () => void }) {
  const pathname = usePathname();
  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  const renderItem = (item: NavItem) => {
    const on = isActive(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        onClick={onNavigate}
        aria-current={on ? 'page' : undefined}
        className={cn(
          'group flex min-h-[44px] items-center gap-3 rounded-[10px] px-3 text-[14.5px] transition-colors',
          on
            ? 'bg-ff-sidebar-active font-bold text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
            : 'font-semibold text-ff-sidebar-ink hover:bg-ff-sidebar-hover',
        )}
      >
        <item.Icon size={19} strokeWidth={on ? 2.2 : 1.8} className={cn('shrink-0', on ? 'text-ff-amber' : 'text-ff-sidebar-muted group-hover:text-ff-sidebar-ink')} />
        <span className="flex-1 truncate">{item.label}</span>
      </Link>
    );
  };

  return (
    <aside className="flex h-full w-[var(--sidebar-w)] shrink-0 flex-col border-r border-ff-sidebar-border bg-ff-sidebar-bg px-3.5 pb-4 pt-5">
      <div className="flex shrink-0 items-center gap-[11px] px-1.5 pb-6">
        <div className="grid h-[40px] w-[40px] place-items-center rounded-[12px] bg-ff-amber text-ff-green-950 shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]">
          <Leaf size={23} strokeWidth={2} />
        </div>
        <div className="leading-[1.1]">
          <div className="font-display text-[18px] font-extrabold tracking-[-0.015em] text-white">ФермериБГ</div>
          <div className="mt-0.5 text-[10.5px] font-extrabold uppercase tracking-[0.14em] text-ff-amber">Платформа</div>
        </div>
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-0.5 [scrollbar-width:thin]">
        <div className="flex flex-col gap-1">{renderItem(HOME)}</div>

        {NAV_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-1">
            <div className="px-3 pb-1 text-[10.5px] font-extrabold uppercase tracking-[0.12em] text-ff-sidebar-muted">
              {group.title}
            </div>
            {group.items.map(renderItem)}
          </div>
        ))}
      </nav>

      <div className="mt-3 flex shrink-0 flex-col gap-1 border-t border-ff-sidebar-border pt-3">
        <Link
          href="/settings"
          onClick={onNavigate}
          aria-current={isActive('/settings') ? 'page' : undefined}
          className={cn(
            'group flex min-h-[44px] items-center gap-3 rounded-[10px] px-3 text-[14.5px] transition-colors',
            isActive('/settings')
              ? 'bg-ff-sidebar-active font-bold text-white'
              : 'font-semibold text-ff-sidebar-ink hover:bg-ff-sidebar-hover',
          )}
        >
          <Settings size={19} strokeWidth={isActive('/settings') ? 2.2 : 1.8} className={cn('shrink-0', isActive('/settings') ? 'text-ff-amber' : 'text-ff-sidebar-muted group-hover:text-ff-sidebar-ink')} />
          <span className="flex-1">Настройки</span>
        </Link>
        <button
          type="button"
          onClick={onLogout}
          className="group flex min-h-[44px] items-center gap-3 rounded-[10px] px-3 text-[14.5px] font-semibold text-ff-sidebar-ink transition-colors hover:bg-ff-sidebar-hover"
        >
          <LogOut size={19} strokeWidth={1.8} className="shrink-0 text-ff-sidebar-muted group-hover:text-ff-sidebar-ink" />
          <span className="flex-1 text-left">Изход</span>
        </button>
      </div>
    </aside>
  );
}
