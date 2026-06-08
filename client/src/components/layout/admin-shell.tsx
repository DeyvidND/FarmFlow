'use client';

import { Toaster } from 'sonner';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { ForcePasswordModal } from '@/components/auth/force-password-modal';
import { useUiStore } from '@/stores/ui-store';

/** Client chrome for the admin panel (sidebar + topbar + drawer + toasts).
 *  Auth is enforced by the server `(admin)/layout.tsx` that wraps this. */
export function AdminShell({
  children,
  subscriptionActive = true,
  tenantName,
  mustChangePassword = false,
}: {
  children: React.ReactNode;
  subscriptionActive?: boolean;
  tenantName?: string;
  /** First login with the temporary password → block the panel with the modal. */
  mustChangePassword?: boolean;
}) {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const closeDrawer = useUiStore((s) => s.closeDrawer);

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar subscriptionActive={subscriptionActive} />

      {drawerOpen && (
        <div
          onClick={closeDrawer}
          className="fixed inset-0 z-[49] animate-ff-fade bg-[rgba(30,28,15,0.4)] lg:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar tenantName={tenantName} />
        <main className="ff-main flex-1 overflow-y-auto px-8 pb-10 pt-8 max-sm:px-4 max-sm:pb-8 max-sm:pt-4">
          <div className="mx-auto max-w-[1200px]">{children}</div>
        </main>
      </div>

      {mustChangePassword && <ForcePasswordModal />}

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
