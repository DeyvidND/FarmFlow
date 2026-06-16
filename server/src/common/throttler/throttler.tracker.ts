/** Minimal shape the tracker needs (the throttler passes the raw request). */
type ReqLike = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  /** Express request path (no query string). Falls back to url/originalUrl. */
  path?: string;
  url?: string;
  originalUrl?: string;
};

/**
 * Unauthenticated, brute-force-sensitive endpoints. These accept NO Bearer token
 * (the route has no auth guard), so principal-keying is unsafe here: an attacker
 * can attach a forged JWT with a rotating `sub` to every request and land each in
 * a distinct `usr:<random>` bucket, fully evading the per-IP cap. For these paths
 * we IGNORE the Authorization header and always key on the client IP. (Safe even
 * behind the BFF: the panels never call these — the browser hits them directly.)
 */
const IP_ONLY_PATHS = new Set([
  '/auth/login',
  '/auth/forgot-password',
  '/auth/reset-password',
]);

/** Request path without query string, tolerant of the field the runtime provides. */
function reqPath(req: ReqLike): string {
  const raw = req.path ?? req.originalUrl ?? req.url ?? '';
  const q = raw.indexOf('?');
  return q === -1 ? raw : raw.slice(0, q);
}

/**
 * Rate-limit bucket key for a request.
 *
 * The admin and tenant panels proxy every call through a server-side BFF, so the
 * API sees the BFF's single IP for all of them — keying purely on IP would
 * collapse every panel user (and, on the multi-tenant client panel, every farm's
 * admins) into one bucket and lock them out together. So:
 *   - Unauthenticated auth routes (login / forgot / reset) → ALWAYS key on
 *     `req.ip` (see IP_ONLY_PATHS). A forged Bearer header must not be allowed to
 *     scatter brute-force attempts across buckets and defeat the per-IP cap.
 *   - Other authenticated requests → key on the JWT principal (`sub`/`adminId`).
 *     The token is DECODED, not verified: this is only for bucketing, and because
 *     these routes ARE guarded, the only requests that reach the limiter belong to
 *     the authenticated caller — a forged token only spreads the attacker's OWN
 *     requests across buckets and can never raise another user's limit.
 *   - Other anonymous requests → key on `req.ip`, which Express derives per the
 *     configured `trust proxy` (TRUST_PROXY): behind a trusted proxy/BFF it is the
 *     real client (from X-Forwarded-For); when the proxy isn't trusted it is the
 *     socket peer. We never parse X-Forwarded-For ourselves, so a directly-exposed
 *     API can't be tricked into trusting a spoofed header.
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
  // Brute-force-sensitive unauthenticated routes: never trust a (forged) Bearer
  // header for bucketing — key strictly on the client IP.
  if (IP_ONLY_PATHS.has(reqPath(req))) return `ip:${clientIp(req)}`;

  const auth = req.headers.authorization;
  const principal = principalFromJwt(Array.isArray(auth) ? auth[0] : auth);
  return principal ? `usr:${principal}` : `ip:${clientIp(req)}`;
}
