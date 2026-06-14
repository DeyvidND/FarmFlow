import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AdminShell } from '@/components/layout/admin-shell';

// Reads the session cookie + validates it against the API on every load.
export const dynamic = 'force-dynamic';

/**
 * Server-side auth gate for the whole admin panel.
 *
 * The middleware only checks that the `ff_session` cookie *exists*; it can't tell
 * whether the JWT is still good. A token can be present but invalid — expired, or
 * (in dev) pointing at a tenant that was wiped by a re-seed. That left the user
 * stuck in an empty, half-broken panel (no data, demo map, disabled buttons).
 *
 * Here we verify the token against the API (`/tenants/me`). If it's missing or the
 * API rejects it, we clear the stale cookie and send the user to /login instead of
 * rendering an empty panel.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');

  // Tenant profile (subscription + name) and the user's mustChangePassword flag in
  // one round-trip pair — the latter drives the blocking first-login modal.
  const [res, account] = await Promise.all([
    fetch(`${API_BASE}/tenants/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    }).catch(() => null),
    fetch(`${API_BASE}/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null),
  ]);

  // Invalid / expired / orphaned session → wipe the cookie and force a fresh login.
  if (!res || !res.ok) {
    redirect('/api/session/logout?reason=expired');
  }

  // The profile carries the subscription status + farm name; pass them down so the
  // sidebar can flag subscription-gated screens and the topbar can show the name
  // without a second round-trip.
  const me = await res.json().catch(() => null);
  if (!me) redirect('/api/session/logout?reason=expired');
  const subscriptionActive = me.subscriptionStatus !== 'inactive';
  const mustChangePassword = account?.mustChangePassword === true;

  return (
    <AdminShell
      subscriptionActive={subscriptionActive}
      tenantName={me.name ?? undefined}
      articlesEnabled={me.articlesEnabled ?? true}
      availabilitySectionEnabled={me.availabilitySectionEnabled ?? false}
      hiddenNav={account?.hiddenNav ?? []}
      mustChangePassword={mustChangePassword}
    >
      {children}
    </AdminShell>
  );
}
