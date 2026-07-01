import { NextResponse } from 'next/server';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';

/**
 * SSO landing from the farmer panel. The panel deep-links here with a short-TTL
 * handoff token; we exchange it for a real delivery session (the exchange is
 * package-gated server-side), set the session cookie, and land on an appropriate
 * page. The panel may request a specific landing via `?next=` (e.g. the farmer
 * „Доставки“ card sends the farmer straight to /import); otherwise we pick by the
 * role embedded in the minted session token:
 *   - farmer → /settings (carrier-connect screen)
 *   - admin  → /shipments
 * On any failure, fall back to the normal login.
 */

/**
 * Allowlist of internal landing paths the panel may request via `?next=`. Kept
 * to known same-origin pages so the param can never be turned into an open
 * redirect — anything outside the set falls back to the role default.
 */
const ALLOWED_NEXT = new Set(['/import', '/shipments', '/settings', '/cod-risk', '/help']);

/**
 * Decode the JWT payload (no signature check — the token was already verified
 * server-side by /auth/handoff) and return the appropriate landing path. A valid
 * allowlisted `next` always wins over the role default.
 */
function landingFor(token: string, next: string | null): string {
  if (next && ALLOWED_NEXT.has(next)) return next;
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return payload?.role === 'farmer' ? '/settings' : '/shipments';
  } catch {
    return '/shipments';
  }
}

/** Build the login-page fallback URL, carrying the API's actual failure reason
 *  (e.g. "Пакетът „Доставки“ не е активен за този магазин") so the farmer isn't
 *  dropped on a bare email/password form with no explanation — SSO is their only
 *  way in, they were never given delivery-web credentials to type there. */
function loginFailUrl(origin: string, msg?: string): URL {
  const u = new URL('/login?reason=handoff', origin);
  if (msg) u.searchParams.set('msg', msg);
  return u;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const next = url.searchParams.get('next');
  if (!token) return NextResponse.redirect(loginFailUrl(url.origin));

  const res = await fetch(`${API_BASE}/auth/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.accessToken) {
    return NextResponse.redirect(loginFailUrl(url.origin, typeof data?.message === 'string' ? data.message : undefined));
  }

  const out = NextResponse.redirect(new URL(landingFor(data.accessToken, next), url.origin));
  out.cookies.set(SESSION_COOKIE, data.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE,
  });
  return out;
}
