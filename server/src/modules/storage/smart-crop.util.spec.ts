import sharp from 'sharp';
import { smartFocal, smartFocalFromUrl, isAllowedImageUrl } from './smart-crop.util';

/** A dark canvas with a bright high-detail block at (left, top) — smartcrop should
 *  pull the focal point toward it. */
async function imageWithSubject(w: number, h: number, top: number, left: number): Promise<Buffer> {
  const subject = await sharp({
    create: { width: 130, height: 130, channels: 3, background: { r: 255, g: 235, b: 180 } },
  })
    .png()
    .toBuffer();
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 18, g: 18, b: 18 } } })
    .composite([{ input: subject, top, left }])
    .jpeg()
    .toBuffer();
}

describe('smartFocal', () => {
  it('pulls the focal point up when the subject sits near the top (portrait)', async () => {
    const f = await smartFocal(await imageWithSubject(300, 500, 40, 85));
    expect(f).not.toBeNull();
    expect(f!.zoom).toBe(1);
    expect(f!.y).toBeLessThan(0.45); // not a blind centre
    expect(f!.x).toBeGreaterThanOrEqual(0);
    expect(f!.x).toBeLessThanOrEqual(1);
  });

  it('pulls the focal point right when the subject sits on the right (landscape)', async () => {
    const f = await smartFocal(await imageWithSubject(500, 300, 85, 350));
    expect(f).not.toBeNull();
    expect(f!.x).toBeGreaterThan(0.5);
  });

  it('returns null on non-image bytes (never throws)', async () => {
    expect(await smartFocal(Buffer.from('definitely not an image'))).toBeNull();
  });
});

describe('isAllowedImageUrl (SSRF guard)', () => {
  const base = 'https://cdn.farmsteadflow.com';

  it('allows a URL under the storage public origin', () => {
    expect(isAllowedImageUrl(`${base}/tenants/ferma/products/abc.webp`, base)).toBe(true);
  });

  it('allows when the base carries a path prefix (origin compared, not path)', () => {
    expect(isAllowedImageUrl(`${base}/x.webp`, `${base}/sub/path`)).toBe(true);
  });

  it.each([
    ['cloud metadata IP', 'http://169.254.169.254/latest/meta-data/'],
    ['loopback', 'http://127.0.0.1:6379/'],
    ['localhost', 'http://localhost/internal'],
    ['private host', 'http://internal-admin.local/'],
    ['look-alike host suffix', 'https://cdn.farmsteadflow.com.evil.com/x'],
    ['credentials-in-userinfo trick', 'https://cdn.farmsteadflow.com@169.254.169.254/x'],
    ['http vs https origin mismatch', 'http://cdn.farmsteadflow.com/x'],
    ['non-http scheme', 'file:///etc/passwd'],
    ['gopher scheme', 'gopher://127.0.0.1:6379/_INFO'],
  ])('rejects %s', (_label, url) => {
    expect(isAllowedImageUrl(url, base)).toBe(false);
  });

  it('rejects when no base is configured', () => {
    expect(isAllowedImageUrl(`${base}/x.webp`, '')).toBe(false);
    expect(isAllowedImageUrl(`${base}/x.webp`, null)).toBe(false);
    expect(isAllowedImageUrl(`${base}/x.webp`, undefined)).toBe(false);
  });

  it('rejects an unparseable URL', () => {
    expect(isAllowedImageUrl('not a url', base)).toBe(false);
  });
});

describe('smartFocalFromUrl (SSRF guard)', () => {
  const base = 'https://cdn.farmsteadflow.com';

  it('never issues a fetch for a disallowed (internal) URL', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const res = await smartFocalFromUrl('http://169.254.169.254/latest/meta-data/', base);
    expect(res).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('never fetches when no storage base is configured', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const res = await smartFocalFromUrl(`${base}/x.webp`, '');
    expect(res).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
