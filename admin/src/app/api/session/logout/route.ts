import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/session';

export async function POST() {
  (await cookies()).delete(SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}

/**
 * GET variant: clears the session cookie and redirects to /login. Used by the
 * panel layout to bounce a stale/invalid session out cleanly (a Server Component
 * render can't mutate cookies, so we delete on the redirect response here).
 */
export async function GET(req: Request) {
  const reason = new URL(req.url).searchParams.get('reason');
  const dest = new URL('/login', req.url);
  if (reason) dest.searchParams.set('reason', reason);
  const res = NextResponse.redirect(dest);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
