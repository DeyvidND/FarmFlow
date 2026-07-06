'use client';

import { Toaster } from 'sonner';
import { Sidebar } from '@/components/layout/sidebar';
import { Topbar } from '@/components/layout/topbar';
import { ForcePasswordModal } from '@/components/auth/force-password-modal';
import { AdblockNotice } from '@/components/layout/adblock-notice';
import { FarmerRouteGuard } from '@/components/layout/farmer-route-guard';
import { FarmerOnboardingModal } from '@/components/layout/farmer-onboarding-modal';
import { RoleProvider } from '@/components/layout/role-context';
import { useUiStore } from '@/stores/ui-store';

/** Client chrome for the admin panel (sidebar + topbar + drawer + toasts).
 *  Auth is enforced by the server `(admin)/layout.tsx` that wraps this. */
export function AdminShell({
  children,
  subscriptionActive = true,
  tenantName,
  articlesEnabled = true,
  deliveryEnabled = true,
  hiddenNav = [],
  mustChangePassword = false,
  role = 'admin',
}: {
  children: React.ReactNode;
  subscriptionActive?: boolean;
  tenantName?: string;
  /** «Статии» feature flag — hides the Статии nav item when off. */
  articlesEnabled?: boolean;
  /** Personal-delivery flag — hides «Маршрут» when the farm doesn't deliver. */
  deliveryEnabled?: boolean;
  /** Per-user hidden side-nav keys (users.hiddenNav). */
  hiddenNav?: string[];
  /** First login with the temporary password → block the panel with the modal. */
  mustChangePassword?: boolean;
  role?: string;
}) {
  const drawerOpen = useUiStore((s) => s.drawerOpen);
  const closeDrawer = useUiStore((s) => s.closeDrawer);

  return (
    <div className="flex h-full overflow-hidden">
      <Sidebar
        subscriptionActive={subscriptionActive}
        articlesEnabled={articlesEnabled}
        deliveryEnabled={deliveryEnabled}
        hiddenNav={hiddenNav}
        role={role}
      />

      {drawerOpen && (
        <div
          onClick={closeDrawer}
          className="fixed inset-0 z-[49] animate-ff-fade bg-[rgba(30,28,15,0.4)] lg:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <Topbar tenantName={tenantName} />
        <main className="ff-main flex-1 overflow-y-auto px-8 pb-10 pt-8 max-sm:px-4 max-sm:pb-8 max-sm:pt-4">
          <div className="mx-auto max-w-[1200px]">
            <RoleProvider role={role}>{children}</RoleProvider>
          </div>
        </main>
      </div>

      {mustChangePassword && <ForcePasswordModal role={role} />}

      {/* Nudge to disable ad-blockers that suppress our error monitoring. Sits
          below the password modal; only shows once a blocker is actually detected. */}
      {!mustChangePassword && <AdblockNotice />}

      {role === 'farmer' && <FarmerRouteGuard />}
      {role === 'farmer' && !mustChangePassword && <FarmerOnboardingModal />}

      <Toaster
        position="bottom-right"
        // Sonner's 4s default doesn't leave much time to read + tap „Отмени" on an
        // undo toast. 6.5s gives an elder user room to notice, read, and react.
        toastOptions={{
          duration: 6500,
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
