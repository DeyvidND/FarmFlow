'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  ClipboardList,
  BarChart3,
  CalendarClock,
  CreditCard,
  ShoppingBasket,
  Package,
  Users,
  Tags,
  Route as RouteIcon,
  Newspaper,
  Mail,
  Image as ImageIcon,
  Leaf,
  Lock,
  LogOut,
  Settings,
  BookOpen,
  Contact,
  ChevronDown,
  MessageSquare,
  Truck,
  LineChart,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui-store';

export interface NavItem {
  href: string;
  label: string;
  Icon: LucideIcon;
  /** Screen needs an active subscription — flagged with a lock when inactive. */
  gated?: boolean;
  /** Plain-Bulgarian one-liner — shown in Settings so the farmer knows what the
   *  screen is before deciding to hide it. */
  desc?: string;
}

export interface NavGroup {
  title: string;
  items: NavItem[];
  /** Set-up-once groups fold away by default to keep the everyday list short. */
  collapsible?: boolean;
  /** Short explanation of the section — shown in the Settings hide/show editor. */
  desc?: string;
}

/** Stable key for hiding a whole section (stored in users.hiddenNav). */
export const navGroupKey = (title: string) => `group:${title}`;

/** Home/overview — stands alone above the grouped sections. Always visible
 *  (the post-login landing page + a safe anchor), so it is never hideable. */
export const HOME: NavItem = {
  href: '/dashboard',
  label: 'Табло',
  Icon: LayoutDashboard,
  desc: 'Начален преглед — обобщение на продажби и поръчки.',
};

// Grouped by function — the everyday order pipeline (Продажби) stays open; the
// set-up-once groups (catalog · marketing · delivery+payment config) fold away
// so the list doesn't overwhelm. Each group is one functional domain, daily-doing
// kept apart from set-once config, and no label repeats a group title.
export const NAV_GROUPS: NavGroup[] = [
  {
    title: 'Продажби',
    desc: 'Ежедневният поток на поръчките — от приемане до доставка и пари.',
    items: [
      { href: '/orders', label: 'Поръчки', Icon: ClipboardList, desc: 'Входящи поръчки от клиенти.' },
      { href: '/production', label: 'Производство', Icon: ShoppingBasket, gated: true, desc: 'Дневен списък какво да приготвиш за доставките.' },
      { href: '/route', label: 'Маршрут', Icon: RouteIcon, gated: true, desc: 'Маршрут за разнасяне на поръчките.' },
      { href: '/payments', label: 'Плащания', Icon: CreditCard, desc: 'Преглед на плащанията и приходите — наложен платеж и карти.' },
      { href: '/stats', label: 'Статистика', Icon: BarChart3, desc: 'Оборот, поръчки, топ продукти и тренд през времето.' },
      { href: '/site-analytics', label: 'Анализ на сайта', Icon: LineChart, desc: 'Посетители, фуния към поръчка, източници и устройства.' },
    ],
  },
  {
    title: 'Каталог',
    collapsible: true,
    desc: 'Какво продаваш — продукти, фермери и категории.',
    items: [
      { href: '/products', label: 'Продукти', Icon: Package, desc: 'Твоят каталог с продукти и цени.' },
      { href: '/farmers', label: 'Фермери', Icon: Users, desc: 'Производителите, чиято стока продаваш.' },
      { href: '/subcategories', label: 'Категории', Icon: Tags, desc: 'Групи, в които подреждаш продуктите си.' },
      { href: '/availability', label: 'Задай наличност', Icon: CalendarClock, gated: true, desc: 'Колко имаш налично от всеки продукт — намалява при поръчка.' },
    ],
  },
  {
    title: 'Съдържание и сайт',
    collapsible: true,
    desc: 'Текстове, снимки, статии и контакти на магазина.',
    items: [
      { href: '/articles', label: 'Статии', Icon: Newspaper, gated: true, desc: 'Блог/новини секция в магазина.' },
      { href: '/reviews', label: 'Отзиви', Icon: MessageSquare, desc: 'Преглед и одобрение на отзивите от клиенти.' },
      { href: '/site-media', label: 'Промени сайта', Icon: ImageIcon, desc: 'Снимки и текстове на сайта — смени какво пише и какви снимки стоят.' },
      { href: '/contacts', label: 'Контакти', Icon: Contact, desc: 'Контактна информация, социални мрежи, локация и иконка на сайта.' },
      { href: '/newsletters', label: 'Имейл клиенти', Icon: Mail, desc: 'Списък с имейли за бюлетин.' },
    ],
  },
];

/** Flattened list (back-compat for any consumer that wants every item). */
export const NAV: NavItem[] = [HOME, ...NAV_GROUPS.flatMap((g) => g.items)];

/** Standalone set-up-once screens reached via deep links (not sidebar items).
 *  They live under Настройки → Конфигурации, so when the user is on one of them
 *  the «Настройки» entry should light up — otherwise nothing is active and the
 *  farmer can't tell where they are or how to get back. */
const CONFIG_ROUTES = ['/setup', '/delivery', '/slots', '/features', '/marketing-tracking'];
const isConfigRoute = (pathname: string) =>
  CONFIG_ROUTES.some((r) => pathname === r || pathname.startsWith(r + '/'));

/** Reduced nav for a producer sub-account (role='farmer'). Grows in later phases. */
export const FARMER_NAV: NavItem[] = [
  { href: '/stats', label: 'Статистика', Icon: BarChart3, desc: 'Твоят личен оборот, поръчки и тренд.' },
  { href: '/site-analytics', label: 'Анализ на сайта', Icon: LineChart, desc: 'Посетители на сайта, фуния към поръчка и източници.' },
  { href: '/products', label: 'Продукти', Icon: Package, desc: 'Твоите продукти — добавяй, променяй цени, снимки и наличност.' },
  { href: '/payments', label: 'Плащания', Icon: CreditCard, desc: 'Плащанията за твоите продукти.' },
  { href: '/availability', label: 'Задай наличност', Icon: CalendarClock, desc: 'Колко имаш налично от всеки продукт — намалява при поръчка.' },
  { href: '/farmer-delivery', label: 'Доставки', Icon: Truck, desc: 'Свържи Speedy/Econt и пращай куриерски поръчки.' },
];

const NAV_ORDER_PREFIX = 'navorder:';
const DEFAULT_NAV_ORDER = NAV_GROUPS.map((g) => g.title);

/** Parse the raw hiddenNav array (which may contain a `navorder:…` entry) into
 *  a clean hidden-keys set and an ordered list of section titles. */
export function parseNavOrder(rawHidden: string[]): { hidden: string[]; navOrder: string[] } {
  const entry = rawHidden.find((k) => k.startsWith(NAV_ORDER_PREFIX));
  const parsed = entry
    ? entry.slice(NAV_ORDER_PREFIX.length).split('|').filter((t) => DEFAULT_NAV_ORDER.includes(t))
    : [...DEFAULT_NAV_ORDER];
  const missing = DEFAULT_NAV_ORDER.filter((t) => !parsed.includes(t));
  return {
    hidden: rawHidden.filter((k) => !k.startsWith(NAV_ORDER_PREFIX)),
    navOrder: [...parsed, ...missing],
  };
}

/** Encode a section-title order back into a single hiddenNav entry. */
export function encodeNavOrder(order: string[]): string {
  return NAV_ORDER_PREFIX + order.join('|');
}

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
  articlesEnabled = true,
  deliveryEnabled = true,
  hiddenNav = [],
  role = 'admin',
}: {
  pendingCount?: number;
  subscriptionActive?: boolean;
  /** «Статии» feature flag — hides the Статии nav item when the section is off. */
  articlesEnabled?: boolean;
  /** Personal-delivery flag — hides «Маршрут» when the farm doesn't deliver. */
  deliveryEnabled?: boolean;
  /** Per-user hidden nav keys (item hrefs + group keys) from users.hiddenNav. */
  hiddenNav?: string[];
  role?: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const navRef = useRef<HTMLElement>(null);

  // Keep the active item visible: deep links can land on a screen that sits far
  // down a scrolled nav (or on a config route → Настройки in the footer). Scroll
  // whatever is active into view whenever the route changes.
  useEffect(() => {
    const el = navRef.current?.querySelector<HTMLElement>('[data-on="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [pathname]);
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
  // Настройки owns the config sub-screens (/setup, /slots, …) — light it up there
  // too, so deep links into a config page still anchor the user in the sidebar.
  const settingsActive =
    pathname === '/settings' || pathname.startsWith('/settings/') || isConfigRoute(pathname);
  const helpActive = pathname === '/help' || pathname.startsWith('/help/');
  const { hidden: hiddenKeys, navOrder } = parseNavOrder(hiddenNav);
  const hidden = new Set(hiddenKeys);
  const sortedGroups = navOrder.map((t) => NAV_GROUPS.find((g) => g.title === t)).filter(Boolean) as NavGroup[];
  // Hide feature-gated items (e.g. Статии when off) AND user-hidden items.
  const visibleItems = (g: NavGroup) =>
    g.items.filter(
      (i) =>
        (i.href === '/articles' ? articlesEnabled : true) &&
        (i.href === '/route' ? deliveryEnabled : true) &&
        !hidden.has(i.href),
    );
  const groupHasActive = (g: NavGroup) => visibleItems(g).some((i) => isActive(i.href));
  // A group is shown when it isn't collapsible, when it holds the active page, or
  // when the farmer has expanded it. Collapsible groups default to folded.
  // Collapsible groups now default to OPEN — everything is visible on load and a
  // farmer can still fold a group to shorten the list. (Folded-by-default hid
  // items like „Фермери" behind a non-obvious dropdown.)
  const isGroupOpen = (g: NavGroup) =>
    !g.collapsible || groupHasActive(g) || (openState[g.title] ?? true);

  function toggleGroup(title: string) {
    setOpenState((prev) => {
      const next = { ...prev, [title]: !(prev[title] ?? true) };
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
          locked && 'opacity-70',
        )}
      >
        <item.Icon size={21} strokeWidth={on ? 2 : 1.8} />
        <span className="flex-1">
          {item.label}
          {/* Visible on tap/glance, not just on hover — a locked icon alone
              reads as "broken" to a non-digital user. */}
          {locked && <span className="ml-1.5 text-[11px] font-semibold text-ff-muted-2">(нужен абонамент)</span>}
        </span>
        {locked && <Lock size={14} className="shrink-0 text-ff-muted-2" />}
        {item.href === '/orders' && pendingCount > 0 && (
          <span
            className={cn(
              'grid h-[21px] min-w-[21px] place-items-center rounded-full px-1.5 text-[12px]s font-extrabold',
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
      ref={navRef}
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
          <div className="font-display text-[19px] font-extrabold tracking-[-0.01em]">ФермериБГ</div>
          <div className="mt-0.5 text-[11.5px] font-semibold text-ff-muted">Управление на фермата</div>
        </div>
      </div>

      <nav className="ff-nav-scroll mt-1 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto pr-0.5 [scrollbar-width:thin]">
        {role === 'farmer' ? (
          <div className="flex flex-col gap-1">{FARMER_NAV.map(renderItem)}</div>
        ) : (
          <>
            {/* Home — always on top, no group header */}
            <div className="flex flex-col gap-1">{renderItem(HOME)}</div>

            {sortedGroups.map((group) => {
              // Whole section hidden by the farmer, or every item in it hidden/off.
              if (hidden.has(navGroupKey(group.title))) return null;
              const items = visibleItems(group);
              if (items.length === 0) return null;
              const open = isGroupOpen(group);
              return (
                <div key={group.title} className="flex flex-col gap-1">
                  {group.collapsible ? (
                    <button
                      type="button"
                      onClick={() => toggleGroup(group.title)}
                      className="flex items-center justify-between rounded-[8px] px-[13px] pb-0.5 pt-1 text-[12px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2 transition-colors hover:text-ff-muted"
                      aria-expanded={open}
                    >
                      <span>{group.title}</span>
                      <ChevronDown
                        size={13}
                        className={cn('shrink-0 transition-transform', !open && '-rotate-90')}
                      />
                    </button>
                  ) : (
                    <div className="px-[13px] pb-0.5 pt-1 text-[12px] font-extrabold uppercase tracking-[0.07em] text-ff-muted-2">
                      {group.title}
                    </div>
                  )}
                  {open && items.map(renderItem)}
                </div>
              );
            })}
          </>
        )}
      </nav>

      {/* Quick-reach row — a duplicate of the topbar avatar menu, but always
          visible with text labels (not hidden behind an avatar/chevron), so a
          non-digital farmer can find Настройки without discovering that menu. */}
      <div className="mt-2 flex shrink-0 items-center gap-1 border-t border-ff-border pt-2.5">
        <Link
          href="/settings"
          onClick={closeDrawer}
          data-on={settingsActive}
          aria-label="Настройки"
          className={cn(
            'flex h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px] font-bold transition-colors',
            settingsActive
              ? 'bg-ff-green-50 text-ff-green-800'
              : 'text-ff-muted hover:bg-ff-green-50 hover:text-ff-ink',
          )}
        >
          <Settings size={19} strokeWidth={settingsActive ? 2 : 1.8} />
          Настройки
        </Link>
        <Link
          href="/help"
          onClick={closeDrawer}
          data-on={helpActive}
          aria-label="Помощ"
          className={cn(
            'flex h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px] font-bold transition-colors',
            helpActive
              ? 'bg-ff-green-50 text-ff-green-800'
              : 'text-ff-muted hover:bg-ff-green-50 hover:text-ff-ink',
          )}
        >
          <BookOpen size={19} strokeWidth={helpActive ? 2 : 1.8} />
          Помощ
        </Link>
        <button
          type="button"
          onClick={onLogout}
          aria-label="Изход"
          className="flex h-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] text-[11px] font-bold text-ff-muted transition-colors hover:bg-ff-green-50 hover:text-ff-ink"
        >
          <LogOut size={19} />
          Изход
        </button>
      </div>
    </aside>
  );
}
