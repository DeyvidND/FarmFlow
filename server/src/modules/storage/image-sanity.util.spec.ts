import sharp from 'sharp';
import { inlineSanityCheck } from './image-sanity.util';

/** Flat color → no edges → low Laplacian variance → reads as blurry. */
async function solidColorJpeg(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 120, g: 140, b: 90 } } })
    .jpeg()
    .toBuffer();
}

/** Random noise → maximal edge energy → reads as sharp, never flagged as blurry. */
async function noiseJpeg(width: number, height: number): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let i = 0; i < raw.length; i++) raw[i] = Math.floor(Math.random() * 256);
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg().toBuffer();
}

describe('inlineSanityCheck', () => {
  it('does not flag a normal-sized, high-detail photo', async () => {
    const buf = await noiseJpeg(800, 800);
    const result = await inlineSanityCheck(buf, 'image/jpeg');
    expect(result).toEqual({ anomaly: false, reasons: [] });
  });

  it('flags a flat/featureless photo as blurry', async () => {
    const buf = await solidColorJpeg(800, 800);
    const result = await inlineSanityCheck(buf, 'image/jpeg');
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toContain('замъглена');
  });

  it('flags a photo below the resolution floor', async () => {
    const buf = await noiseJpeg(200, 200);
    const result = await inlineSanityCheck(buf, 'image/jpeg');
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toContain('ниска резолюция');
  });

  it('flags an extreme aspect ratio', async () => {
    const buf = await noiseJpeg(1500, 200);
    const result = await inlineSanityCheck(buf, 'image/jpeg');
    expect(result.anomaly).toBe(true);
    expect(result.reasons).toContain('необичайно съотношение');
  });

  it('skips non-raster mime types entirely', async () => {
    const result = await inlineSanityCheck(Buffer.from('not-an-image'), 'image/gif');
    expect(result).toEqual({ anomaly: false, reasons: [] });
  });

  it('never throws on unreadable bytes — degrades to "no anomaly"', async () => {
    const result = await inlineSanityCheck(Buffer.from('garbage'), 'image/jpeg');
    expect(result).toEqual({ anomaly: false, reasons: [] });
  });
});
