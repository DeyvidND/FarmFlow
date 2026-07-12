import { ImageSanityVisionClient } from './image-sanity-vision.client';

function makeClient(key: string | null = 'test-key') {
  const config = { get: (k: string, d?: unknown) => (k === 'OPENAI_API_KEY' ? key : d) } as any;
  return new ImageSanityVisionClient(config);
}

function stubOpenAi(client: ImageSanityVisionClient, content: string) {
  (client as any).client = {
    chat: { completions: { create: async () => ({ choices: [{ message: { content } }] }) } },
  };
}

describe('ImageSanityVisionClient.judge', () => {
  it('returns null when OPENAI_API_KEY is not configured', async () => {
    const client = makeClient(null);
    expect(await client.judge('data:image/jpeg;base64,x', ['замъглена'])).toBeNull();
  });

  it('parses a clean ok verdict with no crop', async () => {
    const client = makeClient();
    stubOpenAi(client, JSON.stringify({ rotate: 0, cropBox: null, verdict: 'ok', reason: 'ясна снимка' }));
    const verdict = await client.judge('data:image/jpeg;base64,x', ['замъглена']);
    expect(verdict).toEqual({ rotate: 0, cropBox: undefined, verdict: 'ok', reason: 'ясна снимка' });
  });

  it('parses a rotate + cropBox fix', async () => {
    const client = makeClient();
    stubOpenAi(
      client,
      JSON.stringify({ rotate: 90, cropBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 }, verdict: 'ok', reason: 'изправена и изрязана' }),
    );
    const verdict = await client.judge('data:image/jpeg;base64,x', ['необичайно съотношение']);
    expect(verdict).toEqual({
      rotate: 90,
      cropBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
      verdict: 'ok',
      reason: 'изправена и изрязана',
    });
  });

  it('parses an unusable verdict', async () => {
    const client = makeClient();
    stubOpenAi(client, JSON.stringify({ rotate: 0, verdict: 'unusable', reason: 'продуктът не се вижда' }));
    const verdict = await client.judge('data:image/jpeg;base64,x', ['замъглена']);
    expect(verdict).toEqual({ rotate: 0, cropBox: undefined, verdict: 'unusable', reason: 'продуктът не се вижда' });
  });

  it('discards an out-of-range cropBox and keeps the rest of the verdict', async () => {
    const client = makeClient();
    stubOpenAi(client, JSON.stringify({ rotate: 0, cropBox: { x: 0.8, y: 0.8, width: 0.5, height: 0.5 }, verdict: 'ok', reason: 'x' }));
    const verdict = await client.judge('data:image/jpeg;base64,x', ['замъглена']);
    expect(verdict?.cropBox).toBeUndefined();
  });

  it('defaults an invalid rotate value to 0', async () => {
    const client = makeClient();
    stubOpenAi(client, JSON.stringify({ rotate: 45, verdict: 'ok', reason: 'x' }));
    const verdict = await client.judge('data:image/jpeg;base64,x', ['замъглена']);
    expect(verdict?.rotate).toBe(0);
  });

  it('returns null on malformed JSON instead of throwing', async () => {
    const client = makeClient();
    stubOpenAi(client, 'not json at all');
    expect(await client.judge('data:image/jpeg;base64,x', ['замъглена'])).toBeNull();
  });

  it('returns null when the OpenAI call rejects', async () => {
    const client = makeClient();
    (client as any).client = { chat: { completions: { create: async () => { throw new Error('network'); } } } };
    expect(await client.judge('data:image/jpeg;base64,x', ['замъглена'])).toBeNull();
  });
});
