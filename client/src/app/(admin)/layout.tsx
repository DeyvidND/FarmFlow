import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AdminShell } from '@/components/layout/admin-shell';
import { sessionVerdict } from './layout.session';

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
 * Here we verify the token against the API (`/tenants/me`). Only an explicit
 * 401/403 (see {@link sessionVerdict}) means the token itself is bad — that's
 * the sole case that clears the cookie and sends the user to /login. A network
 * failure or a 5xx means the API is unreachable, not that the session is
 * invalid: we still render the shell (with safe fallbacks) so screens with an
 * offline cache — e.g. the roadside „Проверка" check — can keep working. The
 * middleware still rejects a missing/expired JWT locally, and when the API is
 * down every data call fails too, so there's nothing to leak.
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

  // Only a rejected token (401/403) is an invalid / expired / orphaned session →
  // wipe the cookie and force a fresh login. A network failure or 5xx is the API
  // being unreachable, not the session being bad — fall through and render with
  // safe fallbacks instead.
  const verdict = sessionVerdict(res);
  if (verdict === 'reject') {
    redirect('/api/session/logout?reason=expired');
  }

  // The profile carries the subscription status + farm name; pass them down so the
  // sidebar can flag subscription-gated screens and the topbar can show the name
  // without a second round-trip. When unreachable (network blip, 5xx, or an
  // unparsable body) `me` stays null and we fall back to safe defaults — never
  // lock features or force a re-login over a network failure.
  const me = res && verdict === 'ok' ? await res.json().catch(() => null) : null;
  const subscriptionActive = me ? me.subscriptionStatus !== 'inactive' : true;
  const mustChangePassword = account?.mustChangePassword === true;

  // Present only on a super-admin "full-panel impersonation" session (minted by
  // /auth/panel-handoff) — drives the persistent impersonation banner in the shell.
  const payload = decodeJwtPayload(token);
  const actingAdminId =
    typeof payload?.actingAdminId === 'string' ? payload.actingAdminId : undefined;

  return (
    <AdminShell
      subscriptionActive={subscriptionActive}
      tenantName={me?.name ?? undefined}
      articlesEnabled={me?.articlesEnabled ?? true}
      deliveryEnabled={me?.deliveryEnabled ?? false}
      multiFarmer={me?.multiFarmer ?? false}
      hiddenNav={account?.hiddenNav ?? []}
      mustChangePassword={mustChangePassword}
      role={account?.role ?? 'admin'}
      actingAdminId={actingAdminId}
    >
      {children}
    </AdminShell>
  );
}
