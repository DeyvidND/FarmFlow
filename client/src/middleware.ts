import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

const PROTECTED = [
  '/dashboard',
  '/orders',
  '/production',
  '/products',
  '/farmers',
  '/subcategories',
  '/slots',
  '/delivery',
  '/route',
  '/articles',
  '/newsletters',
  '/settings',
];
const AUTH_PAGES = ['/login'];

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

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const hasSession = Boolean(token);
  const isAuthPage = AUTH_PAGES.includes(pathname);
  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'));

  // No session on a protected admin page → send to login.
  if (!hasSession && isProtected) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Already signed in but on login → skip to the dashboard.
  if (hasSession && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  // Forced password change: redirect to /settings unless already there or calling API.
  if (hasSession && token) {
    const isApiPath = pathname.startsWith('/api/') || pathname.startsWith('/bff/');
    const isSettingsPath = pathname === '/settings' || pathname.startsWith('/settings/');
    if (!isApiPath && !isSettingsPath) {
      const payload = decodeJwtPayload(token);
      if (payload?.mustChangePassword === true) {
        const url = req.nextUrl.clone();
        url.pathname = '/settings';
        return NextResponse.redirect(url);
      }
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/orders/:path*',
    '/production/:path*',
    '/products/:path*',
    '/farmers/:path*',
    '/subcategories/:path*',
    '/slots/:path*',
    '/delivery/:path*',
    '/route/:path*',
    '/articles/:path*',
    '/newsletters/:path*',
    '/newsletters',
    '/settings/:path*',
    '/settings',
    '/login',
  ],
};
