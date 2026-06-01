'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  ClipboardList,
  ShoppingBasket,
  Package,
  Users,
  Tags,
  CalendarDays,
  Route as RouteIcon,
  Newspaper,
  Leaf,
  LogOut,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';

interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
}

export const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Табло', Icon: LayoutDashboard },
  { href: '/orders', label: 'Поръчки', Icon: ClipboardList },
  { href: '/production', label: 'Производство', Icon: ShoppingBasket },
  { href: '/products', label: 'Продукти', Icon: Package },
  { href: '/farmers', label: 'Фермери', Icon: Users },
  { href: '/subcategories', label: 'Подкатегории', Icon: Tags },
  { href: '/slots', label: 'Слотове', Icon: CalendarDays },
  { href: '/route', label: 'Маршрут', Icon: RouteIcon },
  { href: '/articles', label: 'Статии', Icon: Newspaper },
];

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

export function Sidebar({ pendingCount = 0 }: { pendingCount?: number }) {
  const pathname = usePathname();
  const router = useRouter();
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const closeDrawer = useUiStore((s) => s.closeDrawer);

  async function onLogout() {
    await fetch('/api/session/logout', { method: 'POST' }).catch(() => {});
    closeDrawer();
    router.push('/login');
    router.refresh();
  }

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
      <div className="flex items-center gap-[11px] px-1.5 pb-[18px] pt-0.5">
        <Logo />
        <div className="leading-[1.1]">
          <div className="font-display text-[19px] font-extrabold tracking-[-0.01em]">FarmFlow</div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-ff-muted">Управление на фермата</div>
        </div>
      </div>

      <nav className="mt-2 flex flex-col gap-1">
        {NAV.map((item) => {
          const on = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={closeDrawer}
              data-on={on}
              className={cn(
                'ff-nav-item flex items-center gap-[13px] rounded-[10px] border-l-[3px] px-[13px] py-[11px] text-[15px] transition-colors',
                on
                  ? 'border-ff-green-600 bg-ff-green-50 font-bold text-ff-green-800'
                  : 'border-transparent font-semibold text-ff-ink-2 hover:bg-ff-green-50 hover:text-ff-ink',
              )}
            >
              <item.Icon size={21} strokeWidth={on ? 2 : 1.8} />
              <span className="flex-1">{item.label}</span>
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
        })}
      </nav>

      <div className="mt-auto pt-4">
        <div className="rounded-[13px] border border-ff-green-100 bg-ff-green-50 px-[13px] py-3">
          <div className="flex items-center gap-2 text-[12.5px] font-bold text-ff-green-700">
            <span className="h-2 w-2 rounded-full bg-ff-green-500" />
            Сезон активен
          </div>
          <div className="mt-1.5 text-[12.5px] leading-[1.45] text-ff-ink-2">
            Прибиране на реколтата — пик. 9 продукта в наличност.
          </div>
        </div>
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
