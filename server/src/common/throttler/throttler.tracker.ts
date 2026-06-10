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
 *   - Anonymous requests (login / forgot / reset) → key on `req.ip`, which Express
 *     derives per the configured `trust proxy` (TRUST_PROXY): behind a trusted
 *     proxy/BFF it is the real client (from X-Forwarded-For); when the proxy isn't
 *     trusted it is the socket peer. We never parse X-Forwarded-For ourselves, so
 *     a directly-exposed API can't be tricked into trusting a spoofed header.
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
  // `req.ip` honours Express `trust proxy` (TRUST_PROXY) — the real client behind
  // a trusted proxy, the socket peer otherwise. Deliberately NOT parsing
  // X-Forwarded-For here: trusting that client-spoofable header on a directly
  // exposed API would let an attacker rotate it to evade per-IP brute-force limits.
  return req.ip || 'unknown';
}

export function throttlerTracker(req: ReqLike): string {
  const auth = req.headers.authorization;
  const principal = principalFromJwt(Array.isArray(auth) ? auth[0] : auth);
  return principal ? `usr:${principal}` : `ip:${clientIp(req)}`;
}
