import sharp from 'sharp';
import { smartFocal } from './smart-crop.util';

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
