import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE, SESSION_MAX_AGE, extractApiMessage } from '@/lib/session';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  // Forward the EDGE-set client IP so the API rate-limits login per real client,
  // not per BFF. Only cf-connecting-ip is trusted: Cloudflare overwrites it, while
  // the inbound x-forwarded-for is attacker-controlled and could spoof the bucket.
  const fwd = req.headers.get('cf-connecting-ip') ?? undefined;

  const res = await fetch(`${API_BASE}/platform/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
    body: JSON.stringify({ email: body?.email, password: body?.password }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json(
      { message: extractApiMessage(data) ?? 'Грешен имейл или парола' },
      { status: res.status },
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
