import { encryptSecret, decryptSecret } from './secret.util';

/**
 * Encryption for a stored, reusable signature PNG (data-URL). Wraps the shared
 * AES-256-GCM `secret.util`. A signature must NEVER be stored unencrypted: with no
 * `ENCRYPTION_KEY` configured, writes are refused (`SignatureKeyMissingError`) rather
 * than degrading to plaintext.
 */

/** True when `v` has our ciphertext shape: three non-empty base64 parts `iv:tag:ct`.
 *  A plaintext `data:image/png;base64,…` URL has only ONE colon → false. */
export function looksEncrypted(v: string): boolean {
  const parts = v.split(':');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9+/]+=*$/.test(p));
}

/** Thrown when a signature write is attempted with no ENCRYPTION_KEY configured.
 *  Callers translate this into a user-facing error — we never store a signature
 *  in plaintext, even in dev. */
export class SignatureKeyMissingError extends Error {
  constructor() {
    super('ENCRYPTION_KEY is not configured — refusing to store a signature unencrypted');
    this.name = 'SignatureKeyMissingError';
  }
}

export function encryptSignature(plaintext: string, key = process.env.ENCRYPTION_KEY): string {
  if (!key) throw new SignatureKeyMissingError();
  return encryptSecret(plaintext, key);
}

/**
 * Read a stored signature. Order matters:
 *  1. falsy blob → null (no signature),
 *  2. legacy PLAINTEXT data-URL (pre-feature rows) → pass through unchanged,
 *  3. ciphertext but no key → null (we cannot read it; never hand back the raw blob),
 *  4. decrypt failure (rotated key / corruption) → null.
 * null means "no signature" — a legal document then renders an empty signature slot
 * rather than a garbled string.
 */
export function decryptSignature(
  blob: string | null | undefined,
  key = process.env.ENCRYPTION_KEY,
): string | null {
  if (!blob) return null;
  if (!looksEncrypted(blob)) return blob;
  if (!key) return null;
  try {
    return decryptSecret(blob, key);
  } catch {
    return null;
  }
}
