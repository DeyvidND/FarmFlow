'use client';

import { Toaster } from 'sonner';
import { Leaf, LogOut, Settings, Users, Mail, CreditCard, LineChart, Truck, Sprout, ScrollText, AlertTriangle } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

const NAV_LINK =
  'inline-flex shrink-0 items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2 text-[13.5px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2';

export function PanelChrome({ children }: { children: React.ReactNode }) {
  const router = useRouter();

  async function logout() {
    await fetch('/api/session/logout', { method: 'POST' }).catch(() => {});
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="min-h-screen bg-ff-bg">
      <header className="sticky top-0 z-10 flex h-[var(--topbar-h,64px)] items-center justify-between border-b border-ff-border bg-[rgba(251,248,241,0.85)] px-8 backdrop-blur-md max-sm:px-4">
        <div className="flex shrink-0 items-center gap-[11px]">
          <div className="grid h-[38px] w-[38px] place-items-center rounded-[11px] bg-ff-green-700 text-[#EAF1E4]">
            <Leaf size={22} strokeWidth={1.9} />
          </div>
          <div className="leading-[1.1]">
            <div className="font-display text-[17px] font-extrabold tracking-[-0.01em]">ФермериБГ — Платформа</div>
            <div className="mt-0.5 text-[11.5px] font-semibold text-ff-muted">Администрация</div>
          </div>
        </div>
        <div className="ml-3 flex min-w-0 items-center gap-2 overflow-x-auto [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <Link href="/tenants" className={NAV_LINK}>
            <Users size={17} /> <span className="max-sm:hidden">Фермери</span>
          </Link>
          <Link href="/producers" className={NAV_LINK}>
            <Sprout size={17} /> <span className="max-sm:hidden">Производители</span>
          </Link>
          <Link href="/delivery" className={NAV_LINK}>
            <Truck size={17} /> <span className="max-sm:hidden">Доставка</span>
          </Link>
          <Link href="/insights" className={NAV_LINK}>
            <LineChart size={17} /> <span className="max-sm:hidden">Анализ</span>
          </Link>
          <Link href="/problems" className={NAV_LINK}>
            <AlertTriangle size={17} /> <span className="max-sm:hidden">Проблеми</span>
          </Link>
          <Link href="/audit" className={NAV_LINK}>
            <ScrollText size={17} /> <span className="max-sm:hidden">Одит</span>
          </Link>
          <Link href="/email-billing" className={NAV_LINK}>
            <Mail size={17} /> <span className="max-sm:hidden">Имейл сметки</span>
          </Link>
          <Link href="/stripe" className={NAV_LINK}>
            <CreditCard size={17} /> <span className="max-sm:hidden">Stripe</span>
          </Link>
          <Link href="/settings" className={NAV_LINK}>
            <Settings size={17} /> <span className="max-sm:hidden">Настройки</span>
          </Link>
          <button onClick={logout} className={NAV_LINK}>
            <LogOut size={17} /> <span className="max-sm:hidden">Изход</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-[1100px] px-8 py-8 max-sm:px-4">{children}</main>

      <Toaster
        position="bottom-right"
        toastOptions={{
          style: {
            fontFamily: 'var(--font-commissioner)',
            borderRadius: '12px',
            border: '1px solid var(--ff-border)',
            background: 'var(--ff-surface)',
            color: 'var(--ff-ink)',
            fontWeight: 600,
          },
        }}
      />
    </div>
  );
}
