import * as https from 'https';
import * as crypto from 'crypto';

/**
 * Amazon SNS message signature verification (Signature Version 1 and 2).
 *
 * SES delivers bounce/complaint events through an SNS HTTPS subscription. The
 * endpoint is public, so we must prove each message genuinely came from AWS
 * before acting on it — otherwise an attacker could forge bounce events (to
 * suppress a victim's mail) or a `SubscriptionConfirmation` pointing
 * `SubscribeURL` at an internal host (SSRF) that the app would then fetch.
 *
 * Verification follows the documented SNS scheme: rebuild the canonical
 * string-to-sign from a fixed set of fields, fetch the signing certificate
 * (only from an `sns.<region>.amazonaws.com` host), and check the RSA
 * signature with the cert's public key.
 *
 * @see https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 */

// Fields included in the string-to-sign, in the exact order SNS specifies, per
// message type. `Subject` is only present on some Notifications and is skipped
// when absent.
const SIGNABLE_KEYS: Record<string, readonly string[]> = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

// Signing certs are immutable per URL; cache the PEM to avoid refetching on
// every event.
const certCache = new Map<string, string>();

/**
 * True only for genuine AWS SNS HTTPS URLs (`https://sns.<region>.amazonaws.com[.cn]/...`).
 * Used to gate both the signing-cert fetch and the SubscribeURL confirmation
 * fetch, so neither can be pointed at an arbitrary host.
 */
export function isAwsSnsUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/.test(u.hostname)
    );
  } catch {
    return false;
  }
}

function fetchCert(url: string): Promise<string> {
  const cached = certCache.get(url);
  if (cached) return Promise.resolve(cached);
  return new Promise<string>((resolve, reject) => {
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`cert fetch failed: HTTP ${res.statusCode}`));
          return;
        }
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          certCache.set(url, data);
          resolve(data);
        });
      })
      .on('error', reject);
  });
}

/** Build the canonical string-to-sign, or null if the message type is unknown. */
function stringToSign(msg: Record<string, unknown>): string | null {
  const keys = SIGNABLE_KEYS[String(msg.Type)];
  if (!keys) return null;
  let out = '';
  for (const key of keys) {
    const value = msg[key];
    // Skip optional fields that aren't present (e.g. Subject); everything else
    // is required and contributes "key\nvalue\n".
    if (value === undefined || value === null) continue;
    out += `${key}\n${String(value)}\n`;
  }
  return out;
}

/** Fetches the PEM at a (validated) signing-cert URL. Injectable for testing. */
export type CertFetcher = (url: string) => Promise<string>;

/**
 * Verify an SNS message's signature. Resolves `true` only when the signature is
 * present, well-formed, and validates against a certificate fetched from a
 * legitimate SNS host. Any error (bad URL, fetch failure, malformed message)
 * resolves `false` — callers should reject the message.
 *
 * `fetchCertFn` defaults to a cached HTTPS fetch and is overridable in tests.
 */
export async function verifySnsSignature(
  msg: Record<string, unknown>,
  fetchCertFn: CertFetcher = fetchCert,
): Promise<boolean> {
  try {
    const certUrl = msg.SigningCertURL;
    const signature = msg.Signature;
    if (typeof certUrl !== 'string' || !isAwsSnsUrl(certUrl)) return false;
    if (typeof signature !== 'string' || signature.length === 0) return false;

    const payload = stringToSign(msg);
    if (payload === null) return false;

    // SNS uses SHA1 for SignatureVersion 1 and SHA256 for 2.
    const algorithm = String(msg.SignatureVersion) === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    const cert = await fetchCertFn(certUrl);

    const verifier = crypto.createVerify(algorithm);
    verifier.update(payload, 'utf8');
    return verifier.verify(cert, signature, 'base64');
  } catch {
    return false;
  }
}
