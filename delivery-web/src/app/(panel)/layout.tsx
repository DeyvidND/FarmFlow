import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { PanelChrome } from '@/components/panel-chrome';
import { ForcePasswordModal } from '@/components/force-password-modal';

export const dynamic = 'force-dynamic';

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) redirect('/login');

  const me = await fetch(`${API_BASE}/auth/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);

  if (!me) redirect('/api/session/logout');

  // Account still owes a password rotation (e.g. after an admin reset). The API
  // locks every endpoint except change-password until it's done — render the
  // blocking modal instead of the panel.
  if (me.mustChangePassword === true) {
    return <ForcePasswordModal />;
  }

  return <PanelChrome>{children}</PanelChrome>;
}
