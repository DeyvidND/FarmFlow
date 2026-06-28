import { applyDeliverySecrets, stripCarrierSecrets } from './tenants.service';

/**
 * The encrypted carrier password (`<carrier>.passwordEnc`) lives in
 * settings.delivery but is owned solely by each carrier's saveCredentials. These
 * guard the two invariants for EVERY carrier (econt + speedy):
 *  - a plain delivery-settings save (sender/package/…) must not erase a stored
 *    password the client never sees, and
 *  - a client must never be able to write a password into the blob.
 */
describe('delivery carrier secrets', () => {
  describe('applyDeliverySecrets — preserve on save', () => {
    it('carries the stored speedy.passwordEnc forward when the client omits it', () => {
      const existing = { speedy: { configured: true, passwordEnc: 'enc-speedy' } };
      const incoming = { speedy: { configured: true, sender: { contactName: 'Ферма' } } };
      const out = applyDeliverySecrets(existing, incoming);
      expect((out.speedy as Record<string, unknown>).passwordEnc).toBe('enc-speedy');
      expect((out.speedy as Record<string, unknown>).sender).toEqual({ contactName: 'Ферма' });
    });

    it('carries the stored econt.passwordEnc forward (regression)', () => {
      const existing = { econt: { configured: true, passwordEnc: 'enc-econt' } };
      const incoming = { econt: { configured: true, username: 'ferma' } };
      const out = applyDeliverySecrets(existing, incoming);
      expect((out.econt as Record<string, unknown>).passwordEnc).toBe('enc-econt');
    });

    it('preserves both carriers in a single save', () => {
      const existing = {
        econt: { passwordEnc: 'enc-econt' },
        speedy: { passwordEnc: 'enc-speedy' },
      };
      const incoming = { econt: { username: 'e' }, speedy: { userName: 's' } };
      const out = applyDeliverySecrets(existing, incoming);
      expect((out.econt as Record<string, unknown>).passwordEnc).toBe('enc-econt');
      expect((out.speedy as Record<string, unknown>).passwordEnc).toBe('enc-speedy');
    });

    it('passes through when there is no carrier blob', () => {
      const out = applyDeliverySecrets({}, { methods: { pickup: { enabled: true } } });
      expect(out).toEqual({ methods: { pickup: { enabled: true } } });
    });
  });

  describe('applyDeliverySecrets — strip client-sent creds', () => {
    it('drops a client-written speedy.passwordEnc and uses the stored one instead', () => {
      const existing = { speedy: { passwordEnc: 'enc-real' } };
      const incoming = { speedy: { passwordEnc: 'enc-evil', sender: { phone: '0888' } } };
      const out = applyDeliverySecrets(existing, incoming);
      // The injected value is stripped; the stored secret is carried forward.
      expect((out.speedy as Record<string, unknown>).passwordEnc).toBe('enc-real');
    });

    it('drops plaintext password fields on any carrier', () => {
      const incoming = {
        econt: { password: 'plain', username: 'e' },
        speedy: { password: 'plain', userName: 's' },
      };
      const out = applyDeliverySecrets({}, incoming);
      expect((out.econt as Record<string, unknown>).password).toBeUndefined();
      expect((out.speedy as Record<string, unknown>).password).toBeUndefined();
      expect((out.econt as Record<string, unknown>).username).toBe('e');
      expect((out.speedy as Record<string, unknown>).userName).toBe('s');
    });

    it('does not invent a passwordEnc when none is stored', () => {
      const out = applyDeliverySecrets({}, { speedy: { configured: false, sender: {} } });
      expect((out.speedy as Record<string, unknown>).passwordEnc).toBeUndefined();
    });
  });

  describe('stripCarrierSecrets — strip on the way out', () => {
    it('removes passwordEnc from both carriers', () => {
      const stored = {
        econt: { configured: true, passwordEnc: 'enc-econt', username: 'e' },
        speedy: { configured: true, passwordEnc: 'enc-speedy', userName: 's' },
      };
      const out = stripCarrierSecrets(stored) as Record<string, Record<string, unknown>>;
      expect(out.econt.passwordEnc).toBeUndefined();
      expect(out.speedy.passwordEnc).toBeUndefined();
      expect(out.econt.username).toBe('e');
      expect(out.speedy.userName).toBe('s');
    });

    it('returns null for a missing blob', () => {
      expect(stripCarrierSecrets(null)).toBeNull();
      expect(stripCarrierSecrets(undefined)).toBeNull();
    });
  });
});
