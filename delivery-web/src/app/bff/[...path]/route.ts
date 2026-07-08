import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { path: string[] } };

/** Authenticated pass-through to the Nest API using the platform session cookie. */
async function proxy(req: Request, { params }: Ctx) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return Response.json({ message: 'Unauthorized' }, { status: 401 });

  // CSRF defense-in-depth on top of the session cookie's SameSite=Lax: reject a
  // cross-site state change (same-origin/same-site/direct-nav pass through).
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const site = req.headers.get('sec-fetch-site');
    if (site && site !== 'same-origin' && site !== 'same-site' && site !== 'none') {
      return Response.json({ message: 'Cross-site request blocked' }, { status: 403 });
    }
  }

  // No path traversal / control chars in proxied segments.
  const segments = params.path;
  const unsafe = segments.some(
    (s) => s.includes('..') || s.includes('\\') || [...s].some((c) => c.charCodeAt(0) < 0x20),
  );
  if (unsafe) return Response.json({ message: 'Bad request' }, { status: 400 });

  const search = new URL(req.url).search;
  const url = `${API_BASE}/${segments.join('/')}${search}`;

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const contentType = req.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? Buffer.from(await req.arrayBuffer()) : undefined;

  const init: RequestInit = { method: req.method, headers, body };
  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch (err) {
    // Transient upstream connectivity blip — e.g. the `api` service mid-recreate
    // on deploy surfaces as `getaddrinfo EAI_AGAIN api`. The request never reached
    // the API, so retry once; if it still fails, return a clean 502 rather than
    // letting it throw into a 500 + Sentry event. A permanent misconfig
    // (ENOTFOUND) is not transient, so it re-throws and stays visible.
    const code = (err as { cause?: { code?: string } })?.cause?.code;
    const transient =
      code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET';
    if (!transient) throw err;
    await new Promise((r) => setTimeout(r, 400));
    try {
      upstream = await fetch(url, init);
    } catch {
      return Response.json(
        { message: 'Upstream temporarily unavailable' },
        { status: 502, headers: { 'cache-control': 'no-store' } },
      );
    }
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  const resHeaders = new Headers();
  const upCt = upstream.headers.get('content-type');
  if (upCt) resHeaders.set('content-type', upCt);
  // Defense-in-depth: prevent any intermediary (CDN, shared proxy) from caching
  // per-user authenticated responses.
  resHeaders.set('cache-control', 'private, no-store');
  return new Response(buf, { status: upstream.status, headers: resHeaders });
}

export { proxy as GET, proxy as POST, proxy as PATCH, proxy as PUT, proxy as DELETE };
