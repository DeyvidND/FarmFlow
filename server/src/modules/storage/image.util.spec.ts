import sharp from 'sharp';
import { squareFavicon } from './image.util';

describe('squareFavicon', () => {
  it('center-crops a non-square PNG to a square icon', async () => {
    const rect = await sharp({
      create: { width: 1375, height: 1772, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();
    const out = await squareFavicon(rect, 'image/png');
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(meta.height);
    expect(meta.format).toBe('png');
  });

  it('leaves ICO input untouched', async () => {
    const buf = Buffer.from([1, 2, 3, 4]);
    const out = await squareFavicon(buf, 'image/x-icon');
    expect(out).toBe(buf);
  });

  it('falls back to the original bytes if sharp can’t decode the input', async () => {
    const garbage = Buffer.from('not a real png');
    const out = await squareFavicon(garbage, 'image/png');
    expect(out).toBe(garbage);
  });
});
