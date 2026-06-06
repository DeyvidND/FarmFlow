import { generateKeyPairSync, createSign, type KeyObject } from 'crypto';
import { isAwsSnsUrl, verifySnsSignature, type CertFetcher } from './sns-signature';

// A real SNS signing cert is an X.509 PEM, but Node's verifier also accepts a
// bare public-key PEM — so we sign with a throwaway RSA key and have the
// injected cert fetcher return its public key.
let privateKey: KeyObject;
let publicKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
});

// Cert fetcher that returns the matching public key (the happy path).
const goodFetcher: CertFetcher = async () => publicKeyPem;
// Fetcher that fails the test if it is ever called (used to prove we reject
// bad cert URLs *before* making any network call).
const neverFetcher: CertFetcher = async () => {
  throw new Error('fetch should not have been called');
};

// Mirror the production canonical string for a Notification (no Subject).
function sign(msg: Record<string, string>): string {
  const order = ['Message', 'MessageId', 'Timestamp', 'TopicArn', 'Type'];
  let str = '';
  for (const k of order) str += `${k}\n${msg[k]}\n`;
  return createSign('RSA-SHA1').update(str, 'utf8').sign(privateKey, 'base64');
}

function baseMessage(certUrl = 'https://sns.eu-central-1.amazonaws.com/cert.pem'): Record<string, string> {
  const msg: Record<string, string> = {
    Type: 'Notification',
    MessageId: 'abc-123',
    TopicArn: 'arn:aws:sns:eu-central-1:1:farmflow',
    Message: '{"notificationType":"Bounce"}',
    Timestamp: '2026-06-06T00:00:00.000Z',
    SignatureVersion: '1',
    SigningCertURL: certUrl,
  };
  msg.Signature = sign(msg);
  return msg;
}

describe('isAwsSnsUrl', () => {
  it('accepts genuine SNS hosts over https', () => {
    expect(isAwsSnsUrl('https://sns.eu-central-1.amazonaws.com/x.pem')).toBe(true);
    expect(isAwsSnsUrl('https://sns.us-east-1.amazonaws.com.cn/x.pem')).toBe(true);
  });
  it('rejects look-alikes, http, and junk', () => {
    expect(isAwsSnsUrl('https://sns.eu-central-1.amazonaws.com.evil.com/x')).toBe(false);
    expect(isAwsSnsUrl('https://evil.com/sns.amazonaws.com')).toBe(false);
    expect(isAwsSnsUrl('http://sns.eu-central-1.amazonaws.com/x')).toBe(false);
    expect(isAwsSnsUrl('not a url')).toBe(false);
  });
});

describe('verifySnsSignature', () => {
  it('accepts a correctly signed message', async () => {
    await expect(verifySnsSignature(baseMessage(), goodFetcher)).resolves.toBe(true);
  });

  it('rejects a tampered message (signature no longer matches)', async () => {
    const msg = baseMessage();
    msg.Message = '{"notificationType":"Bounce","tampered":true}';
    await expect(verifySnsSignature(msg, goodFetcher)).resolves.toBe(false);
  });

  it('rejects a cert URL that is not an AWS SNS host, without fetching', async () => {
    const msg = baseMessage('https://evil.example.com/cert.pem');
    await expect(verifySnsSignature(msg, neverFetcher)).resolves.toBe(false);
  });

  it('rejects a message with no signature', async () => {
    const msg = baseMessage();
    delete msg.Signature;
    await expect(verifySnsSignature(msg, goodFetcher)).resolves.toBe(false);
  });

  it('rejects an unknown message type', async () => {
    const msg = baseMessage();
    msg.Type = 'Bogus';
    await expect(verifySnsSignature(msg, goodFetcher)).resolves.toBe(false);
  });
});
