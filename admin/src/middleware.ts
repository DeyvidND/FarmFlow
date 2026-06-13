import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

/** Decode the JWT payload without verifying signature (UX guard only). */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Fast edge-side token check (no signature verification — the API is the real
 * authority, re-checked server-side in the panel layout). Catches the cheap cases:
 * a missing, malformed, or expired cookie must never count as a session.
 */
function tokenStatus(token: string | undefined): 'none' | 'invalid' | 'valid' {
  if (!token) return 'none';
  const payload = decodeJwtPayload(token);
  if (!payload) return 'invalid';
  const exp = typeof payload.exp === 'number' ? payload.exp : null;
  if (exp !== null && exp * 1000 <= Date.now()) return 'invalid';
  return 'valid';
}

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const status = tokenStatus(req.cookies.get(SESSION_COOKIE)?.value);
  const isAuthPage = pathname === '/login';
  const isProtected = ['/tenants', '/email-billing', '/stripe', '/settings', '/insights'].some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );

  // Stale/malformed/expired token → treat as logged-out AND wipe the cookie so it
  // can't keep slipping the user into an empty, broken panel.
  if (status === 'invalid') {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    const res = isProtected ? NextResponse.redirect(url) : NextResponse.next();
    res.cookies.delete(SESSION_COOKIE);
    return res;
  }

  const authed = status === 'valid';

  if (!authed && isProtected) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  if (authed && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/tenants';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: [
    '/tenants/:path*',
    '/email-billing/:path*',
    '/stripe/:path*',
    '/stripe',
    '/settings/:path*',
    '/insights/:path*',
    '/insights',
    '/login',
  ],
};
