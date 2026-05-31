import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

const PROTECTED = ['/dashboard', '/orders', '/production', '/products', '/slots', '/route', '/articles'];
const AUTH_PAGES = ['/login', '/register'];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  const isAuthPage = AUTH_PAGES.includes(pathname);
  const isProtected = PROTECTED.some((p) => pathname === p || pathname.startsWith(p + '/'));

  // No session on a protected admin page → send to login.
  if (!hasSession && isProtected) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  // Already signed in but on login/register → skip to the dashboard.
  if (hasSession && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/dashboard';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    '/dashboard/:path*',
    '/orders/:path*',
    '/production/:path*',
    '/products/:path*',
    '/slots/:path*',
    '/route/:path*',
    '/articles/:path*',
    '/login',
    '/register',
  ],
};
