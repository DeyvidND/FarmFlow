import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const hasSession = Boolean(req.cookies.get(SESSION_COOKIE)?.value);
  const isAuthPage = pathname === '/login';
  const isProtected = ['/tenants', '/email-billing', '/settings'].some(
    (p) => pathname === p || pathname.startsWith(p + '/'),
  );

  if (!hasSession && isProtected) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }
  if (hasSession && isAuthPage) {
    const url = req.nextUrl.clone();
    url.pathname = '/tenants';
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/tenants/:path*', '/email-billing/:path*', '/settings/:path*', '/login'],
};
