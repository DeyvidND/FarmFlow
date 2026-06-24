import { SpeedyClient } from './speedy.client';

describe('SpeedyClient', () => {
  const creds = { base: 'https://api.speedy.bg/v1', userName: 'u', password: 'p', clientSystemId: 7 };
  let client: SpeedyClient;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    client = new SpeedyClient();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });

  it('call injects credentials into the JSON body and returns parsed json', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ ok: 1 }) });
    const out = await client.call(creds, 'location/site', { name: 'София' });
    expect(out).toEqual({ ok: 1 });
    const [, init] = fetchMock.mock.calls[0];
    const sent = JSON.parse(init.body);
    expect(sent.userName).toBe('u');
    expect(sent.password).toBe('p');
    expect(sent.clientSystemId).toBe(7);
    expect(sent.name).toBe('София');
  });

  it('call throws BadRequest on a Speedy JSON error envelope (HTTP 200)', async () => {
    fetchMock.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ error: { message: 'bad creds' } }) });
    await expect(client.call(creds, 'shipment', {})).rejects.toThrow(/bad creds/);
  });

  it('call throws BadRequest on a non-ok HTTP status', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, text: async () => '{}' });
    await expect(client.call(creds, 'shipment', {})).rejects.toThrow(/401/);
  });

  it('callSafe returns null instead of throwing (degradable lookups)', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const out = await client.callSafe(creds, 'location/site', {});
    expect(out).toBeNull();
  });
});
