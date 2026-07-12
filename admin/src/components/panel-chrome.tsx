'use client';

import { useState } from 'react';
import { Toaster } from 'sonner';
import { Menu } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { PanelSidebar, currentTitle } from '@/components/panel-sidebar';

export function PanelChrome({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [drawer, setDrawer] = useState(false);
  const title = currentTitle(pathname);

  async function logout() {
    await fetch('/api/session/logout', { method: 'POST' }).catch(() => {});
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="flex h-screen overflow-hidden bg-ff-bg">
      {/* Desktop sidebar — the permanent navigation spine. */}
      <div className="hidden lg:flex">
        <PanelSidebar onLogout={logout} />
      </div>

      {/* Mobile off-canvas drawer */}
      {drawer && (
        <div className="fixed inset-0 z-[60] lg:hidden" role="dialog" aria-modal="true">
          <div className="animate-ff-fade absolute inset-0 bg-ff-overlay" onClick={() => setDrawer(false)} />
          <div className="animate-ff-slide-in absolute inset-y-0 left-0 shadow-ff-lg">
            <PanelSidebar onNavigate={() => setDrawer(false)} onLogout={logout} />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 flex h-[var(--topbar-h)] shrink-0 items-center gap-3 border-b border-ff-border bg-[rgba(251,248,241,0.85)] px-4 backdrop-blur-md sm:px-6">
          <button
            type="button"
            onClick={() => setDrawer(true)}
            aria-label="Отвори менюто"
            className="grid h-10 w-10 place-items-center rounded-lg border border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2 lg:hidden"
          >
            <Menu size={19} />
          </button>
          <h1 className="font-display text-[19px] font-extrabold tracking-[-0.015em] text-ff-ink">{title}</h1>
        </header>

        <main className="flex-1 overflow-y-auto px-4 py-7 sm:px-6 lg:px-8">
          <div className="mx-auto max-w-[1180px]">{children}</div>
        </main>
      </div>

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
