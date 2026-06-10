import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PanelChrome } from '@/components/panel-chrome';
import { ForcePasswordModal } from '@/components/force-password-modal';

// Validate the platform token against the API on every load.
export const dynamic = 'force-dynamic';

/**
 * Server-side auth gate for the whole super-admin panel.
 *
 * The middleware only checks that the `ff_admin_session` cookie *exists*; it can't
 * tell whether the JWT is still valid (expired, revoked by a password change, or
 * pointing at a deleted admin). Here we verify it against the API (`/platform/me`)
 * and bounce a bad session to login rather than render an empty, half-broken panel
 * — mirroring the farmer app's gate. When the admin still owes a password rotation
 * (`mustChangePassword`), we render the blocking force-change modal instead of the
 * panel (the API also locks every other endpoint until it's done).
 */
export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');

  const me = await fetch(`${API_BASE}/platform/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  // Invalid / expired / revoked session → clear cookie and force a fresh login.
  if (!me) redirect('/api/session/logout?reason=expired');

  if (me.mustChangePassword === true) {
    return <ForcePasswordModal />;
  }

  return <PanelChrome>{children}</PanelChrome>;
}
