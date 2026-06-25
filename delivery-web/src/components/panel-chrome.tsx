'use client';

import { Toaster } from 'sonner';
import { Truck, LogOut, Upload, Package, ShieldAlert, Settings, HelpCircle } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';

const NAV = [
  { href: '/import', label: 'Внос', icon: Upload },
  { href: '/shipments', label: 'Пратки', icon: Package },
  { href: '/cod-risk', label: 'COD риск', icon: ShieldAlert },
  { href: '/settings', label: 'Настройки', icon: Settings },
  { href: '/help', label: 'Помощ', icon: HelpCircle },
] as const;

export function PanelChrome({ children }: { children: React.ReactNode }) {
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
            <div className="mt-0.5 text-[11.5px] font-semibold text-ff-muted">Операторски панел</div>
          </div>
        </div>

        <nav className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = isActive(href);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex h-[44px] shrink-0 items-center gap-2 rounded-xl border px-3.5 text-[13.5px] font-bold transition-all ${
                  active
                    ? 'border-ff-green-700 bg-ff-green-700 text-white shadow-ff-md'
                    : 'border-ff-border bg-ff-surface text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2'
                }`}
              >
                <Icon size={17} /> <span className="max-md:hidden">{label}</span>
              </Link>
            );
          })}
          <button
            onClick={logout}
            className="inline-flex h-[44px] shrink-0 items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2"
          >
            <LogOut size={17} /> <span className="max-md:hidden">Изход</span>
          </button>
        </nav>
      </header>

      <main className="mx-auto max-w-[1100px] px-8 py-8 max-sm:px-4">{children}</main>

      <Toaster
        position="bottom-right"
        toastOptions={{
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
