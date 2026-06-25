import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE, extractApiMessage } from '@/lib/session';

/**
 * Delivery-account password change. Forwards to the econt API, then re-sets the
 * session cookie from the FRESH token it returns — the API bumps the user's
 * tokenVersion on change (revoking the old token) and clears the
 * mustChangePassword lock, so without refreshing the cookie the next request
 * would 401.
 */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) {
    return NextResponse.json({ message: 'Не сте влезли в системата' }, { status: 401 });
  }

  const fwd = req.headers.get('cf-connecting-ip') ?? undefined;
  const res = await fetch(`${API_BASE}/auth/change-password`, {
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

  if (!res.ok || !data?.accessToken) {
    return NextResponse.json(
      { message: extractApiMessage(data) ?? 'Грешна текуща парола' },
      { status: res.status || 400 },
    );
  }

  cookies().set(SESSION_COOKIE, data.accessToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE,
  });

  return NextResponse.json({ ok: true });
}
