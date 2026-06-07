import { NextResponse } from 'next/server';
import { API_BASE, extractApiMessage } from '@/lib/session';

/** Proxy to the API's reset-link request. Always succeeds (no user enumeration). */
export async function POST(req: Request) {
  const body = await req.json().catch(() => null);

  // Forward only the EDGE-set client IP (cf-connecting-ip): Cloudflare overwrites
  // it, while inbound x-forwarded-for is attacker-controlled and could spoof the
  // rate-limit bucket.
  const fwd = req.headers.get('cf-connecting-ip') ?? undefined;

  const res = await fetch(`${API_BASE}/auth/forgot-password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(fwd ? { 'x-forwarded-for': fwd } : {}) },
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
