import { throttlerTracker } from './throttler.tracker';

// A syntactically-valid JWT (header.payload.signature) carrying a chosen `sub`.
// Signature is irrelevant — the tracker decodes, never verifies.
function jwtWithSub(sub: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub })}.sig`;
}

describe('throttlerTracker', () => {
  it('keys authenticated (guarded) requests on the JWT principal', () => {
    const req = {
      headers: { authorization: `Bearer ${jwtWithSub('user-1')}` },
      ip: '10.0.0.1',
      path: '/orders',
    };
    expect(throttlerTracker(req)).toBe('usr:user-1');
  });

  it('keys anonymous requests on the client IP', () => {
    expect(throttlerTracker({ headers: {}, ip: '10.0.0.9', path: '/orders' })).toBe('ip:10.0.0.9');
  });

  describe('brute-force protection on unauthenticated auth routes', () => {
    // The exploit: an attacker hits /auth/login with a forged Bearer whose `sub`
    // rotates each request. If the tracker honoured the principal, every guess
    // would land in its own bucket and the per-IP cap would be bypassed.
    for (const path of ['/auth/login', '/auth/forgot-password', '/auth/reset-password']) {
      it(`ignores a forged Bearer on ${path} and keys on IP`, () => {
        const ip = '203.0.113.7';
        const a = throttlerTracker({ headers: { authorization: `Bearer ${jwtWithSub('rand-a')}` }, ip, path });
        const b = throttlerTracker({ headers: { authorization: `Bearer ${jwtWithSub('rand-b')}` }, ip, path });
        // Same IP → same bucket regardless of the rotating forged principal.
        expect(a).toBe(`ip:${ip}`);
        expect(b).toBe(`ip:${ip}`);
        expect(a).toBe(b);
      });
    }

    it('matches the path even when the runtime only exposes originalUrl with a query string', () => {
      const out = throttlerTracker({
        headers: { authorization: `Bearer ${jwtWithSub('rand')}` },
        ip: '203.0.113.8',
        originalUrl: '/auth/login?foo=bar',
      });
      expect(out).toBe('ip:203.0.113.8');
    });
  });

  it('falls back to "unknown" when no IP is resolvable', () => {
    expect(throttlerTracker({ headers: {}, path: '/auth/login' })).toBe('ip:unknown');
  });
});
