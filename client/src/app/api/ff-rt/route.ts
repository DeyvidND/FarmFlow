// Manual Sentry tunnel — forwards the browser's error envelope to Sentry ingest
// from the server. A same-origin path (/api/ff-rt) dodges ad-blockers, and a
// plain server-side fetch avoids Sentry's `tunnelRoute` external-rewrite proxy,
// which 500s under Next output:'standalone' in Docker. The browser SDK targets
// this via `tunnel` in sentry.client.config.ts and includes the DSN in the
// envelope header so we know where to forward.
//
// Guarded to relay ONLY our own configured project — never an open relay.
import type { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CONFIGURED_DSN = process.env.NEXT_PUBLIC_SENTRY_DSN;

export async function POST(req: NextRequest) {
  if (!CONFIGURED_DSN) {
    // Sentry disabled (no DSN baked) — accept and drop so the SDK doesn't retry.
    return new Response(null, { status: 204 });
  }

  let allowedHost: string;
  let allowedProject: string;
  try {
    const u = new URL(CONFIGURED_DSN);
    allowedHost = u.hostname;
    allowedProject = u.pathname.replace(/^\//, '');
  } catch {
    return new Response('bad configured dsn', { status: 500 });
  }

  try {
    const envelopeBytes = await req.arrayBuffer();
    const head = new TextDecoder().decode(envelopeBytes.slice(0, 1024));
    const newline = head.indexOf('\n');
    const header = JSON.parse(newline === -1 ? head : head.slice(0, newline)) as {
      dsn?: string;
    };
    if (!header.dsn) return new Response('missing dsn in envelope', { status: 400 });

    const dsn = new URL(header.dsn);
    const projectId = dsn.pathname.replace(/^\//, '');
    // Only ever forward to our own project — block use as an open proxy.
    if (dsn.hostname !== allowedHost || projectId !== allowedProject) {
      return new Response('forbidden', { status: 403 });
    }

    const upstream = `https://${dsn.hostname}/api/${projectId}/envelope/`;
    let res: Response;
    try {
      res = await fetch(upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-sentry-envelope' },
        body: envelopeBytes,
        // Fail fast instead of hanging (which the edge masks as a generic 502)
        // if the container can't reach Sentry's ingest host.
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      const err = e as Error;
      // TEMP DIAGNOSTIC: Cloudflare masks 5xx bodies, so return 200 to surface
      // the real reason. Revert to 502 once the cause is known.
      return new Response(
        `DEBUG tunnel fetch failed: ${err.name}: ${err.message}${
          err.cause ? ' | cause: ' + String(err.cause) : ''
        }`,
        { status: 200 },
      );
    }
    // Buffer the upstream response (avoid any streaming edge cases under
    // output:'standalone') and pass it straight back to the SDK.
    const respBody = await res.arrayBuffer();
    return new Response(respBody, { status: res.status });
  } catch (e) {
    return new Response(`tunnel error: ${(e as Error).message}`, { status: 502 });
  }
}
