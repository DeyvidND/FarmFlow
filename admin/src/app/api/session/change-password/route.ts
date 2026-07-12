import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE, extractApiMessage } from '@/lib/session';

/**
 * Super-admin password change. Forwards to the API, then re-sets the session
 * cookie from the FRESH token it returns — the API bumps the admin's tokenVersion
 * on change, which revokes the old token, so without refreshing the cookie the
 * next request would 401. Also clears the mustChangePassword lock.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ message: 'Не сте влезли в системата' }, { status: 401 });
  }

  const fwd = req.headers.get('cf-connecting-ip') ?? undefined;
  const res = await fetch(`${API_BASE}/platform/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(fwd ? { 'x-forwarded-for': fwd } : {}),
    },
    body: JSON.stringify({
      currentPassword: body?.currentPassword,
      newPassword: body?.newPassword,
    }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json(
      { message: extractApiMessage(data) ?? 'Грешна текуща парола' },
      { status: res.status },
    );
  }

  (await cookies()).set(SESSION_COOKIE, data.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE,
  });

  return NextResponse.json({ ok: true });
}
