import { NextResponse } from 'next/server';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/session';

/**
 * SSO landing from the farmer panel. The panel deep-links here with a short-TTL
 * handoff token; we exchange it for a real delivery session (the exchange is
 * package-gated server-side), set the session cookie, and land on the shipments
 * monitor. On any failure, fall back to the normal login.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  const failUrl = new URL('/login?reason=handoff', url.origin);
  if (!token) return NextResponse.redirect(failUrl);

  const res = await fetch(`${API_BASE}/auth/handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.accessToken) return NextResponse.redirect(failUrl);

  const out = NextResponse.redirect(new URL('/shipments', url.origin));
  out.cookies.set(SESSION_COOKIE, data.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE,
  });
  return out;
}
