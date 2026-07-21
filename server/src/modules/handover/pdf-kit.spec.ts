import { A4_LANDSCAPE, A4_PORTRAIT, contentW, createDoc, dateBg, ensureSpace, MARGIN, newPage, wrap } from './pdf-kit';

describe('pdf-kit geometry', () => {
  it('exposes A4 both ways round', () => {
    expect(A4_PORTRAIT).toEqual({ w: 595, h: 842 });
    expect(A4_LANDSCAPE).toEqual({ w: 842, h: 595 });
  });

  it('content width follows the page size, not a hardcoded constant', async () => {
    const p = await createDoc(A4_PORTRAIT);
    const l = await createDoc(A4_LANDSCAPE);
    expect(contentW(p)).toBe(595 - 2 * MARGIN);
    expect(contentW(l)).toBe(842 - 2 * MARGIN);
  });
});

describe('pdf-kit page breaks', () => {
  it('newPage resets the cursor to the top of a fresh page', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.y = 100;
    newPage(d);
    expect(d.y).toBe(A4_PORTRAIT.h - MARGIN);
    expect(d.doc.getPageCount()).toBe(2);
  });

  it('ensureSpace breaks only when the block does not fit', async () => {
    const d = await createDoc(A4_PORTRAIT);
    d.y = 400;
    expect(ensureSpace(d, 100)).toBe(false);
    expect(d.doc.getPageCount()).toBe(1);

    d.y = MARGIN + 10; // almost at the foot
    expect(ensureSpace(d, 100)).toBe(true);
    expect(d.doc.getPageCount()).toBe(2);
    expect(d.y).toBe(A4_PORTRAIT.h - MARGIN);
  });
});

describe('wrap', () => {
  it('never emits a line wider than the limit', async () => {
    const d = await createDoc(A4_PORTRAIT);
    const long = '„Земеделска кооперация Слънчоглед и партньори" ООД, гр. Русе, бул. Липник 123, ет. 4';
    for (const line of wrap(long, d.font, 11, 200)) {
      expect(d.font.widthOfTextAtSize(line, 11)).toBeLessThanOrEqual(200);
    }
  });

  it('keeps a single unbreakable word rather than dropping it', async () => {
    const d = await createDoc(A4_PORTRAIT);
    expect(wrap('Свръхдългодумабезинтервали', d.font, 11, 10)).toEqual(['Свръхдългодумабезинтервали']);
  });
});

describe('dateBg', () => {
  it('dates in Europe/Sofia even though the suite runs UTC', () => {
    // 22:30Z on the 16th is 01:30 on the 17th in Sofia (EEST, UTC+3).
    expect(dateBg(new Date('2026-07-16T22:30:00Z'))).toBe('17.07.2026 г.');
  });
});
