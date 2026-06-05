/** Minimal shape the tracker needs (the throttler passes the raw request). */
type ReqLike = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
};

/**
 * Rate-limit bucket key for a request.
 *
 * The admin and tenant panels proxy every call through a server-side BFF, so the
 * API sees the BFF's single IP for all of them — keying purely on IP would
 * collapse every panel user (and, on the multi-tenant client panel, every farm's
 * admins) into one bucket and lock them out together. So:
 *   - Authenticated requests → key on the JWT principal (`sub`/`adminId`). The
 *     token is DECODED, not verified: this is only for bucketing, and the worst a
 *     forged token can do is spread the attacker's OWN requests across buckets —
 *     it can never raise another user's limit (real auth is enforced by the
 *     guards). So per-user limits hold regardless of the shared BFF IP.
 *   - Anonymous requests (login / forgot / reset) → key on the client IP, taken
 *     from the left-most `X-Forwarded-For` (the original client, forwarded by the
 *     BFF/edge) and falling back to the socket IP.
 *
 * The API must sit behind a proxy/BFF that sets `X-Forwarded-For`; do not expose
 * it raw to the internet (a direct client could otherwise spoof the header).
 */
function principalFromJwt(auth?: string): string | null {
  if (!auth || !auth.startsWith('Bearer ')) return null;
  const parts = auth.slice(7).split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const id = payload?.sub ?? payload?.adminId;
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

function clientIp(req: ReqLike): string {
  const xff = req.headers['x-forwarded-for'];
  const first = Array.isArray(xff) ? xff[0] : xff?.split(',')[0];
  return (first && first.trim()) || req.ip || 'unknown';
}

export function throttlerTracker(req: ReqLike): string {
  const auth = req.headers.authorization;
  const principal = principalFromJwt(Array.isArray(auth) ? auth[0] : auth);
  return principal ? `usr:${principal}` : `ip:${clientIp(req)}`;
}
