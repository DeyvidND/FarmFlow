import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AdminShell } from '@/components/layout/admin-shell';

/**
 * Decode the JWT payload without verifying the signature — display-only, to
 * read the `actingAdminId` claim a super-admin "full-panel impersonation"
 * session carries. The API already verified the token; this just surfaces the
 * claim so the shell can show the impersonation banner. Mirrors the decode
 * logic in `middleware.ts` (kept separate since middleware runs on the edge
 * runtime and this is a plain Node.js server component).
 */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

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
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
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

  // Present only on a super-admin "full-panel impersonation" session (minted by
  // /auth/panel-handoff) — drives the persistent impersonation banner in the shell.
  const payload = decodeJwtPayload(token);
  const actingAdminId =
    typeof payload?.actingAdminId === 'string' ? payload.actingAdminId : undefined;

  return (
    <AdminShell
      subscriptionActive={subscriptionActive}
      tenantName={me.name ?? undefined}
      articlesEnabled={me.articlesEnabled ?? true}
      deliveryEnabled={me.deliveryEnabled ?? false}
      multiFarmer={me.multiFarmer ?? false}
      hiddenNav={account?.hiddenNav ?? []}
      mustChangePassword={mustChangePassword}
      role={account?.role ?? 'admin'}
      actingAdminId={actingAdminId}
    >
      {children}
    </AdminShell>
  );
}
