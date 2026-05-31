/** Platform-admin session: platform JWT in an httpOnly cookie, bridged to the
 *  Nest API's Authorization: Bearer by route handlers. Separate cookie from the
 *  farmer (tenant) panel so the two sessions never collide. */
export const SESSION_COOKIE = 'ff_admin_session';

/** Matches the API's JWT expiresIn: '7d'. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export const API_BASE = process.env.API_URL ?? 'http://localhost:3001';

/** Dig the human message out of the API's double-nested error body. */
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
