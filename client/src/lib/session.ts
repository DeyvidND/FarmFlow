/** Server-side session helpers. The JWT lives in an httpOnly cookie; route
 *  handlers bridge it to the Nest API's `Authorization: Bearer` header. */
export const SESSION_COOKIE = 'ff_session';

/** Matches the API's JWT `expiresIn: '7d'`. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

/** Base URL of the Nest API (server-to-server; never exposed to the browser). */
export const API_BASE = process.env.API_URL ?? 'http://localhost:3001';

/**
 * Pull the human-readable error out of a Nest error body. The API's global
 * filter wraps `HttpException.getResponse()` under `message`, so the real text
 * (string for business errors, string[] for validation) sits at
 * `body.message.message`. Returns string | string[] | undefined.
 */
export function extractApiMessage(body: unknown): string | string[] | undefined {
  const outer = (body as { message?: unknown })?.message;
  if (outer && typeof outer === 'object' && !Array.isArray(outer)) {
    const inner = (outer as { message?: unknown }).message;
    if (typeof inner === 'string' || Array.isArray(inner)) return inner as string | string[];
    return undefined;
  }
  if (typeof outer === 'string' || Array.isArray(outer)) return outer as string | string[];
  return undefined;
}
