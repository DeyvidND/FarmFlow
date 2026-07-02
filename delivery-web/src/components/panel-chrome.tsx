'use client';

import { Toaster } from 'sonner';
import { Truck, LogOut, Upload, Package, ShieldAlert, Settings, HelpCircle } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { CarrierOnboarding } from './carrier-onboarding';
import { ActivationBanner } from './activation-banner';
import { A11yToggle } from './a11y-toggle';

const NAV = [
  { href: '/shipments', label: 'Пратки', mobileLabel: 'Пратки', icon: Package },
  { href: '/import', label: 'Качи пратки', mobileLabel: 'Качи', icon: Upload },
  { href: '/cod-risk', label: 'Проверка на клиент', mobileLabel: 'Проверка', icon: ShieldAlert },
  { href: '/settings', label: 'Настройки', mobileLabel: 'Настройки', icon: Settings },
  { href: '/help', label: 'Помощ', mobileLabel: 'Помощ', icon: HelpCircle },
] as const;

export function PanelChrome({ children, email }: { children: React.ReactNode; email?: string }) {
  const router = useRouter();
  const pathname = usePathname();

  async function logout() {
    await fetch('/api/session/logout', { method: 'POST' }).catch(() => {});
    router.push('/login');
    router.refresh();
  }

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');

  return (
    <div className="min-h-screen bg-ff-bg">
      <header className="sticky top-0 z-10 flex h-[var(--topbar-h,64px)] items-center justify-between gap-3 border-b border-ff-border bg-[rgba(251,248,241,0.85)] px-8 shadow-ff-sm backdrop-blur-md max-lg:px-4">
        <div className="flex shrink-0 items-center gap-[11px]">
          <div className="grid h-[38px] w-[38px] place-items-center rounded-[11px] bg-ff-green-700 text-[#EAF1E4]">
            <Truck size={22} strokeWidth={1.9} />
          </div>
          <div className="leading-[1.1] max-md:hidden">
            <div className="font-display text-[17px] font-extrabold tracking-[-0.01em]">ФермериБГ · Доставка</div>
            <div className="mt-0.5 text-[13px] font-semibold text-ff-muted">Управление на доставки</div>
          </div>
        </div>

        {/* Primary nav — flat text links; only the active page gets a filled pill, so the
            bar reads like a header rather than a row of buttons. */}
        {/* On mobile the row switches to icon-over-label (not icon-only — a bare glyph
            reads as unlabeled to a non-digital user); each link grows to an even, finger-
            sized target. Full labels return at lg. */}
        <nav className="flex min-w-0 flex-1 items-center justify-center gap-1 overflow-x-auto px-2 max-lg:gap-0.5 max-lg:px-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {NAV.map(({ href, label, mobileLabel, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                title={label}
                className={`inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg px-3 text-[13.5px] font-bold transition-colors max-lg:h-12 max-lg:grow max-lg:basis-0 max-lg:flex-col max-lg:gap-0.5 max-lg:px-1 ${
                  active
                    ? 'bg-ff-green-700 text-white'
                    : 'text-ff-ink-2 hover:bg-ff-surface-2'
                }`}
              >
                <Icon size={18} className="max-lg:size-[19px]" />
                <span className="max-lg:hidden">{label}</span>
                <span className="hidden max-lg:block max-lg:text-[9.5px] max-lg:font-bold max-lg:leading-none">{mobileLabel}</span>
              </Link>
            );
          })}
        </nav>

        {/* Account cluster — avatar + a compact logout, set apart from the nav by a divider. */}
        <div className="flex shrink-0 items-center gap-2 border-l border-ff-border pl-3">
          <A11yToggle />
          {email && (
            <span
              title={`Влязъл като ${email}`}
              className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-ff-green-700 text-[13px] font-extrabold uppercase text-white max-lg:h-11 max-lg:w-11 max-lg:text-[15px]"
            >
              {email.trim()[0] ?? '?'}
            </span>
          )}
          <button
            onClick={logout}
            title="Изход"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg px-2.5 text-[13.5px] font-bold text-ff-ink-2 transition-colors hover:bg-ff-surface-2 max-lg:h-11 max-lg:w-11 max-lg:px-0"
          >
            <LogOut size={18} className="max-lg:size-5" /> <span className="max-md:hidden">Изход</span>
          </button>
        </div>
      </header>

      <ActivationBanner />
      <CarrierOnboarding />

      <main className="mx-auto max-w-[1100px] px-8 py-8 max-sm:px-4">{children}</main>

      <Toaster
        position="bottom-right"
        // Sonner's 4s default doesn't leave much time to read + react. 6.5s gives
        // an elder user room to notice and read before it disappears.
        toastOptions={{
          duration: 6500,
          style: {
            fontFamily: 'var(--font-commissioner)', borderRadius: '12px',
            border: '1px solid var(--ff-border)', background: 'var(--ff-surface)',
            color: 'var(--ff-ink)', fontWeight: 600,
          },
        }}
      />
    </div>
  );
}
