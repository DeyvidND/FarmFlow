import { encryptSecret, decryptSecret } from './secret.util';

/**
 * Encryption for a stored, reusable signature PNG (data-URL). Wraps the shared
 * AES-256-GCM `secret.util`. `ENCRYPTION_KEY` is OPTIONAL in this deployment, so
 * both helpers DEGRADE to plaintext when no key is configured (dev) — the feature
 * still works; production always has the key set (Econt creds require it too).
 */

/** True when `v` has our ciphertext shape: three non-empty base64 parts `iv:tag:ct`.
 *  A plaintext `data:image/png;base64,…` URL has only ONE colon → false. */
export function looksEncrypted(v: string): boolean {
  const parts = v.split(':');
  return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9+/]+=*$/.test(p));
}

export function encryptSignature(plaintext: string, key = process.env.ENCRYPTION_KEY): string {
  if (!key) return plaintext;
  return encryptSecret(plaintext, key);
}

export function decryptSignature(
  blob: string | null | undefined,
  key = process.env.ENCRYPTION_KEY,
): string | null {
  if (!blob) return null;
  if (!key || !looksEncrypted(blob)) return blob;
  try {
    return decryptSecret(blob, key);
  } catch {
    // Never 500 a legal document over one mis-shaped signature value.
    return blob;
  }
}
