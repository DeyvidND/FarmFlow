import { NextResponse } from 'next/server';
import { API_BASE, extractApiMessage } from '@/lib/session';

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const fwd = req.headers.get('cf-connecting-ip') ?? undefined;
  const res = await fetch(`${API_BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
    body: JSON.stringify({ token: body?.token, newPassword: body?.newPassword }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    return NextResponse.json(
      { message: extractApiMessage(data) ?? 'Връзката е невалидна или изтекла' },
      { status: res.status || 400 },
    );
  return NextResponse.json({ ok: true });
}
