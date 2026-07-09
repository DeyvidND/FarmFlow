import { NextResponse } from 'next/server';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';

/**
 * SSO landing for super-admin "full-panel impersonation". The super-admin panel
 * deep-links here with a short-TTL handoff token minted by
 * `POST /platform/impersonate-panel/:tenantId`; we exchange it for a real farmer
 * session (the exchange is single-use, verified server-side by
 * `/auth/panel-handoff`), set the session cookie, and land on /dashboard.
 *
 * The minted session carries `actingAdminId` and expires in 60 minutes — much
 * shorter than a normal 7-day login — so the cookie TTL here must match that,
 * not the usual `SESSION_MAX_AGE`. On any failure, fall back to the normal login.
 */

const IMPERSONATION_MAX_AGE = 60 * 60; // 60 minutes — matches the server's panel-handoff session TTL.

export async function GET(req: Request) {
  const url = new URL(req.url);
  const token = url.searchParams.get('token');
  if (!token) return NextResponse.redirect(new URL('/login?reason=handoff', url.origin));

  const res = await fetch(`${API_BASE}/auth/panel-handoff`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.accessToken) {
    return NextResponse.redirect(new URL('/login?reason=handoff', url.origin));
  }

  const out = NextResponse.redirect(new URL('/dashboard', url.origin));
  out.cookies.set(SESSION_COOKIE, data.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: IMPERSONATION_MAX_AGE,
  });
  return out;
}
