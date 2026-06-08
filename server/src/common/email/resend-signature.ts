import * as crypto from 'crypto';

/**
 * Resend webhook signature verification (Svix scheme).
 *
 * Resend signs every webhook with Svix. Three headers travel with the POST:
 *   svix-id, svix-timestamp (unix-seconds), svix-signature.
 * The signed content is `${id}.${timestamp}.${rawBody}`, HMAC-SHA256'd with the
 * endpoint's signing secret (`whsec_<base64>` — the base64 part is the raw key),
 * base64-encoded. The `svix-signature` header is a space-delimited list of
 * `v<n>,<base64sig>` pairs; any matching `v1` entry validates the message.
 *
 * The endpoint is public, so we verify this before acting on any event — a forged
 * `email.bounced` / `email.complained` could suppress a victim's mail. We also
 * reject stale timestamps (replay protection; Svix default tolerance is 5 min).
 *
 * @see https://resend.com/docs/dashboard/webhooks/verify-webhooks-requests
 */
export interface SvixHeaders {
  id?: unknown; // svix-id
  timestamp?: unknown; // svix-timestamp
  signature?: unknown; // svix-signature
}

/**
 * Verify a Resend (Svix) webhook signature over the exact raw request body.
 * Returns `true` only when headers + secret are present, the timestamp is fresh,
 * and at least one `v1` signature matches. Any malformed input returns `false`.
 *
 * `nowSec` is the current unix time in seconds (injected for deterministic tests).
 */
export function verifyResendSignature(
  headers: SvixHeaders,
  payload: string,
  secret: string,
  nowSec: number,
  toleranceSec = 300,
): boolean {
  const { id, timestamp, signature } = headers;
  if (
    !secret ||
    typeof id !== 'string' ||
    typeof timestamp !== 'string' ||
    typeof signature !== 'string'
  ) {
    return false;
  }

  // Replay guard: timestamp is unix-seconds; reject if outside the tolerance.
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;

  // `whsec_<base64>` → raw HMAC key bytes.
  const secretB64 = secret.startsWith('whsec_') ? secret.slice(6) : secret;
  const key = Buffer.from(secretB64, 'base64');
  if (key.length === 0) return false;

  const signedContent = `${id}.${timestamp}.${payload}`;
  const expected = crypto.createHmac('sha256', key).update(signedContent).digest();

  // Header: space-delimited "version,signature" pairs; check every v1 entry.
  for (const part of signature.split(' ')) {
    const comma = part.indexOf(',');
    if (comma < 0) continue;
    if (part.slice(0, comma) !== 'v1') continue;
    const sig = Buffer.from(part.slice(comma + 1), 'base64');
    if (sig.length === expected.length && crypto.timingSafeEqual(sig, expected)) {
      return true;
    }
  }
  return false;
}
