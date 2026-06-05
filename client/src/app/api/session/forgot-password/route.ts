import { NextResponse } from 'next/server';
import { API_BASE, extractApiMessage } from '@/lib/session';

/** Proxy to the API's reset-link request. Always succeeds (no user enumeration). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  const res = await fetch(`${API_BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: body?.email }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    return NextResponse.json(
      { message: extractApiMessage(data) ?? 'Възникна грешка' },
      { status: res.status },
    );
  }
  return NextResponse.json({ ok: true });
}
