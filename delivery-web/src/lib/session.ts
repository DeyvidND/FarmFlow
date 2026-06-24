/** Standalone delivery-account session: the econt JWT in an httpOnly cookie,
 *  bridged to the API's Authorization: Bearer by the route handlers. Own cookie
 *  name so it never collides with the farmer or super-admin sessions. */
export const SESSION_COOKIE = 'ff_delivery_session';

/** Matches the API JWT expiresIn: '7d'. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

/** The standalone delivery (econt) API. */
export const API_BASE = process.env.API_URL ?? 'http://localhost:3100';

/** Dig the human message out of the API's (possibly nested) error body. */
export function extractApiMessage(body: unknown): string | undefined {
  const outer = (body as { message?: unknown })?.message;
  const inner =
    outer && typeof outer === 'object' && !Array.isArray(outer)
      ? (outer as { message?: unknown }).message
      : outer;
  if (Array.isArray(inner)) return typeof inner[0] === 'string' ? inner[0] : undefined;
  if (typeof inner === 'string') return inner;
  return undefined;
}
