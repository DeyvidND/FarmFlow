import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE, extractApiMessage } from '@/lib/session';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const token = (await cookies()).get(SESSION_COOKIE)?.value;

  if (!token) {
    return NextResponse.json({ message: 'Не сте влезли в системата' }, { status: 401 });
  }

  const res = await fetch(`${API_BASE}/auth/change-password`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
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
