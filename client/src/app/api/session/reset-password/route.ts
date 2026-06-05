import { NextResponse } from 'next/server';
import { API_BASE, extractApiMessage } from '@/lib/session';

/** Proxy to the API's password reset (token + new password). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  const res = await fetch(`${API_BASE}/auth/reset-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: body?.token, newPassword: body?.newPassword }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json(
      { message: extractApiMessage(data) ?? 'Връзката е невалидна или изтекла' },
      { status: res.status },
    );
  }
  return NextResponse.json({ ok: true });
}
