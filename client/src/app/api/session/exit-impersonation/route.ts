import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/session';

/**
 * "Изход" action on the impersonation banner. Clears the impersonated session
 * cookie and sends the operator back to /login — deliberately a plain logout
 * rather than a return-to-admin hop, since the impersonated session has no
 * memory of the admin's own credentials to restore.
 */
export async function GET(req: Request) {
  const res = NextResponse.redirect(new URL('/login', req.url));
  // Delete on the redirect response itself so the Set-Cookie reliably attaches
  // (a Server Component render can't mutate cookies — same reason /logout does this).
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
