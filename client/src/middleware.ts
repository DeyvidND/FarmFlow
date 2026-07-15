import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

// Every page under the (admin) route group. Keep in sync with `config.matcher`
// below — Next requires the matcher to be a static literal, so the two lists
// can't be derived from one another, but they MUST cover the same routes or a
// page silently loses its edge-side auth check + stale-cookie wipe.
const PROTECTED = [
  '/articles',
  '/availability',
  '/contacts',
  '/dashboard',
  '/delivery',
  '/farmers',
  '/features',
  '/help',
  '/marketing-tracking',
  '/newsletters',
  '/orders',
  '/payments',
  '/prep',
  '/products',
  '/reviews',
  '/route',
  '/settings',
  '/setup',
  '/site-media',
  '/slots',
  '/stats',
  '/subcategories',
];
const AUTH_PAGES = ['/login'];

// Producers may only open their own screens; bounce anything else to /stats.
// UX only — the server's default-deny guard on each endpoint is the real boundary.
// Keep in sync with FARMER_ALLOWED in components/layout/farmer-route-guard.tsx.
const FARMER_ALLOWED = [
  '/stats',
  '/my-report',
  '/payments',
  '/availability',
  '/products',
  '/my-orders',
  '/prep',
  '/farmer-delivery',
  '/settings',
  '/help',
];

// Driver (courier) logins only ever need the route screen, their prep
// checklist, + help; bounce anything else to /route. UX only — the server's
// default-deny guard is the real boundary. Keep in sync with DRIVER_ALLOWED
// in components/layout/driver-route-guard.tsx.
const DRIVER_ALLOWED = ['/route', '/prep', '/help'];

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
 * Fast, edge-side token check (no signature verification — the API is the real
 * authority, re-checked server-side in the admin layout). Catches the cheap cases:
 * a missing, malformed, or expired cookie should never count as a session.
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
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const status = tokenStatus(token);
  const isAuthPage = AUTH_PAGES.includes(pathname);
  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'));

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

  // No session on a protected admin page → send to login.
  if (!authed && isProtected) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Already signed in but on login → skip to the dashboard.
  if (authed && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  // Farmer/driver role on a screen outside their allow-list → bounce before any
  // render, so admin-only content never paints for them (was a client-side
  // useEffect redirect, which flashed the admin dashboard for a frame first).
  if (authed && isProtected) {
    const role = token ? decodeJwtPayload(token)?.role : undefined;
    if (role === 'farmer') {
      const allowed = FARMER_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + '/'));
      if (!allowed) {
        const url = req.nextUrl.clone();
        url.pathname = '/stats';
        return NextResponse.redirect(url);
      }
    } else if (role === 'driver') {
      const allowed = DRIVER_ALLOWED.some((p) => pathname === p || pathname.startsWith(p + '/'));
      if (!allowed) {
        const url = req.nextUrl.clone();
        url.pathname = '/route';
        return NextResponse.redirect(url);
      }
    }
  }

  // Forced password change is handled by the blocking ForcePasswordModal (rendered
  // in AdminShell on any admin page) plus the server-side MustChangePasswordGuard,
  // so the user lands on the dashboard with the modal over it — no edge redirect.

  return NextResponse.next();
}

export const config = {
  // Must cover the same routes as PROTECTED above (bare + nested form for each).
  matcher: [
    '/articles',
    '/articles/:path*',
    '/availability',
    '/availability/:path*',
    '/contacts',
    '/contacts/:path*',
    '/dashboard',
    '/dashboard/:path*',
    '/delivery',
    '/delivery/:path*',
    '/farmers',
    '/farmers/:path*',
    '/features',
    '/features/:path*',
    '/help',
    '/help/:path*',
    '/marketing-tracking',
    '/marketing-tracking/:path*',
    '/newsletters',
    '/newsletters/:path*',
    '/orders',
    '/orders/:path*',
    '/payments',
    '/payments/:path*',
    '/prep',
    '/prep/:path*',
    '/products',
    '/products/:path*',
    '/reviews',
    '/reviews/:path*',
    '/route',
    '/route/:path*',
    '/settings',
    '/settings/:path*',
    '/setup',
    '/setup/:path*',
    '/site-media',
    '/site-media/:path*',
    '/slots',
    '/slots/:path*',
    '/stats',
    '/stats/:path*',
    '/subcategories',
    '/subcategories/:path*',
    '/login',
  ],
};
