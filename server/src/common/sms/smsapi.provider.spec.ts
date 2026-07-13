import { Logger } from '@nestjs/common';
import { SmsApiProvider } from './smsapi.provider';

/** Build a minimal Response-like object for the mocked fetch. */
function mockResponse(opts: { ok: boolean; status?: number; json?: unknown; text?: string }) {
  return {
    ok: opts.ok,
    status: opts.status ?? (opts.ok ? 200 : 500),
    json: async () => opts.json ?? {},
    text: async () => opts.text ?? '',
  } as unknown as Response;
}

/** Parse the captured form-urlencoded request body back into params. */
function bodyParams(spy: jest.SpyInstance): URLSearchParams {
  const [, init] = spy.mock.calls[0] as [string, RequestInit];
  return new URLSearchParams(init.body as string);
}

describe('SmsApiProvider', () => {
  const logger = new Logger('test');
  const cfg = { url: 'https://api.smsapi.bg/sms.do', token: 'tok' };
  let fetchSpy: jest.SpyInstance;

  afterEach(() => {
    fetchSpy?.mockRestore();
  });

  it('ECO send (no senderId): posts form-encoded, Bearer auth, no `from`, strips +', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: true, json: { count: 1, list: [{ id: 'm1', parts: 1, status: 'QUEUE' }] } }),
    );
    const provider = new SmsApiProvider({ ...cfg, senderId: '' }, logger);

    const res = await provider.send('+359888123456', 'здравей');

    // URL + auth + content type
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.smsapi.bg/sms.do');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect((init.headers as Record<string, string>)['content-type']).toBe(
      'application/x-www-form-urlencoded',
    );
    // Body params
    const p = bodyParams(fetchSpy);
    expect(p.get('to')).toBe('359888123456'); // leading + stripped
    expect(p.get('message')).toBe('здравей');
    expect(p.get('format')).toBe('json');
    expect(p.get('encoding')).toBe('utf-8');
    expect(p.has('from')).toBe(false); // ECO — no sender name
    // Result
    expect(res).toEqual({ providerMessageId: 'm1', segments: 1 });
  });

  it('branded send: includes `from` when senderId is set', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: true, json: { count: 1, list: [{ id: 'm2' }] } }),
    );
    const provider = new SmsApiProvider({ ...cfg, senderId: 'ФермериБГ' }, logger);

    await provider.send('+359888123456', 'тест');

    expect(bodyParams(fetchSpy).get('from')).toBe('ФермериБГ');
  });

  it('throws on a SMSAPI error payload (does not treat it as success)', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: true, json: { error: 13, message: 'No valid recipients' } }),
    );
    const provider = new SmsApiProvider({ ...cfg, senderId: '' }, logger);

    await expect(provider.send('+359888123456', 'x')).rejects.toThrow('smsapi error 13');
  });

  it('throws on a non-2xx HTTP response', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: false, status: 401, text: 'Unauthorized' }),
    );
    const provider = new SmsApiProvider({ ...cfg, senderId: '' }, logger);

    await expect(provider.send('+359888123456', 'x')).rejects.toThrow('smsapi http 401');
  });

  it('falls back to computed segments when the payload omits `parts`', async () => {
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      mockResponse({ ok: true, json: { count: 1, list: [{ id: 'm3' }] } }),
    );
    const provider = new SmsApiProvider({ ...cfg, senderId: '' }, logger);

    const res = await provider.send('+359888123456', 'кратко');

    expect(res.providerMessageId).toBe('m3');
    expect(res.segments).toBe(1); // 'кратко' = 6 Cyrillic chars → 1 UCS-2 segment
  });
});
