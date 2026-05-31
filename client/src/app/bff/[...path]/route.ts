import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: { path: string[] } };

/**
 * Authenticated pass-through to the Nest API. Reads the httpOnly `ff_session`
 * cookie and forwards the request with an `Authorization: Bearer` header so
 * browser code never touches the JWT. Body is buffered (handles JSON + multipart
 * image uploads). Reusable for every admin feature: call `/bff/<path>`.
 *
 * NOTE: lives outside `/api` on purpose — next.config's `/api/:path*` rewrite is
 * an afterFiles rewrite, which Next checks *before* dynamic (catch-all) routes,
 * so an `/api/proxy/[...path]` handler would be shadowed by it.
 */
async function proxy(req: Request, { params }: Ctx) {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) {
    return Response.json({ message: 'Unauthorized' }, { status: 401 });
  }

  const search = new URL(req.url).search;
  const url = `${API_BASE}/${params.path.join('/')}${search}`;

  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  const contentType = req.headers.get('content-type');
  if (contentType) headers['content-type'] = contentType;

  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? Buffer.from(await req.arrayBuffer()) : undefined;

  const upstream = await fetch(url, { method: req.method, headers, body });

  const buf = Buffer.from(await upstream.arrayBuffer());
  const resHeaders = new Headers();
  const upCt = upstream.headers.get('content-type');
  if (upCt) resHeaders.set('content-type', upCt);
  return new Response(buf, { status: upstream.status, headers: resHeaders });
}

export {
  proxy as GET,
  proxy as POST,
  proxy as PATCH,
  proxy as PUT,
  proxy as DELETE,
};
