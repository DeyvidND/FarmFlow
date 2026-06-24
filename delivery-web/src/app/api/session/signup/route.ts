import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE, extractApiMessage } from '@/lib/session';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const fwd = req.headers.get('cf-connecting-ip') ?? undefined;

  const res = await fetch(`${API_BASE}/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
    body: JSON.stringify({
      email: body?.email,
      password: body?.password,
      farmName: body?.farmName,
      phone: body?.phone || undefined,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data?.accessToken) {
    return NextResponse.json({ message: extractApiMessage(data) ?? 'Регистрацията се провали' }, { status: res.status || 400 });
  }
  cookies().set(SESSION_COOKIE, data.accessToken, {
    httpOnly: true, sameSite: 'lax', path: '/',
    secure: process.env.NODE_ENV === 'production', maxAge: SESSION_MAX_AGE,
  });
  return NextResponse.json({ ok: true });
}
