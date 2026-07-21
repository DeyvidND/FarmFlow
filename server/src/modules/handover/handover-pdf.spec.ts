import { readFileSync } from 'fs';
import { join } from 'path';
import { PDFDocument, PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { CONTENT_W, composeProtocol, renderProtocolPdf, wrap } from './handover-pdf';
import { MARGIN } from './pdf-kit';

/** Row shape for the render smoke tests (no phone/email — legacy-shaped row). */
const ROW = {
  kind: 'farmer_to_operator', protocolNumber: 41,
  signedAt: new Date('2026-07-13T09:00:00Z'), createdAt: new Date('2026-07-13T08:00:00Z'),
  fromSnapshot: { name: 'ЕТ Васил Петров', eik: '203912345', address: 'с. Розино' },
  toSnapshot: { name: 'ЕТ Оператор', eik: '111222333', address: 'гр. Варна, бул. Сливница 1' },
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг', priceStotinki: 300 }],
  totalStotinki: 1500, fromSignaturePng: null, toSignaturePng: null, signMode: 'pending',
};

const isPdf = (buf: Buffer) => buf.length > 1000 && buf.subarray(0, 5).toString() === '%PDF-';

/** Fixture for the pure-text `composeProtocol` assertions (task-7 brief). */
const base = {
  kind: 'farmer_to_operator',
  protocolNumber: 7,
  signedAt: new Date('2026-07-20T09:00:00Z'),
  fromSnapshot: { name: 'ЕТ Димка Четова', eik: '203912345', address: 'гр. Варна, ул. Приморска 12', phone: '0888123456', email: 'dimka@example.bg' },
  toSnapshot: { name: 'ФермериБГ ЕООД', eik: '206000111', address: 'гр. Варна, бул. Сливница 1', phone: '0700', email: 'ops@fermeri.bg' },
  items: [{ productName: 'Домати', quantity: 5, unit: 'кг' }],
  meta: { orderNumbers: [101, 102] },
};

describe('composeProtocol (bilateral)', () => {
  it('builds the two-party structure with our data', () => {
    const t = composeProtocol(base);
    expect(t.title).toBe('ПРИЕМО-ПРЕДАВАТЕЛЕН ПРОТОКОЛ');
    expect(t.number).toBe('№ 7');
    expect(t.opening).toContain('Днес, 20.07.2026 г.');
    expect(t.opening).toContain('в гр. Варна');
    expect(t.from.role).toBe('ПРЕДАВА:');
    expect(t.from.name).toBe('ЕТ Димка Четова');
    expect(t.from.idLine).toBe('ЕИК 203912345');
    expect(t.from.phone).toBe('0888123456');
    expect(t.to.role).toBe('ПРИЕМА:');
    expect(t.intro).toContain('се състави настоящият приемо-предавателен протокол');
    expect(t.itemLines[0]).toBe('1. Домати — 5 кг');
    expect(t.footer).toContain('два еднообразни екземпляра');
  });

  it('customer leg → разписка, no ЕИК on the customer', () => {
    const t = composeProtocol({ ...base, kind: 'operator_to_customer', toSnapshot: { name: 'Иван Петров', phone: '0899', address: 'гр. Варна' } });
    expect(t.title).toBe('РАЗПИСКА ЗА ПОЛУЧЕНА СТОКА');
    expect(t.to.idLine).toBeNull();
  });

  it('drops the „в гр." clause when the operator address has no settlement', () => {
    const t = composeProtocol({ ...base, fromSnapshot: { ...base.fromSnapshot }, toSnapshot: { ...base.toSnapshot, address: 'ул. без град' } });
    expect(t.opening).not.toContain('в гр.');
  });

  it('dates the protocol in Europe/Sofia even when the process runs UTC (as prod does)', () => {
    // The suite runs UTC (see test/set-tz.ts) because prod and CI do, while dev
    // machines here run Europe/Sofia — where a local-getter bug would have produced
    // the right answer and hidden. 2026-07-16T22:30:00Z is 01:30 on the 17th in
    // Sofia (EEST, UTC+3): the протокол is a legal document and must carry the
    // date it was actually signed.
    const t = composeProtocol({ ...base, signedAt: new Date('2026-07-16T22:30:00Z') });
    expect(t.opening).toContain('17.07.2026 г.');
    expect(t.opening).not.toContain('16.07.2026 г.');
  });

  it('never prints an empty labelled field — omits idLine/phone/email that have no value', () => {
    const t = composeProtocol({ ...base, toSnapshot: { name: 'ФермериБГ ЕООД', address: 'гр. Варна, бул. Сливница 1' } });
    expect(t.to.idLine).toBeNull();
    expect(t.to.phone).toBeNull();
    expect(t.to.email).toBeNull();
  });

  it('renders a variant label and no number for an unsaved preview row', () => {
    const t = composeProtocol({
      ...base, protocolNumber: null,
      items: [{ productName: 'Яйца', variantLabel: 'размер L', quantity: 30, unit: 'бр' }],
    });
    expect(t.number).toBeNull();
    expect(t.itemLines).toEqual(['1. Яйца · размер L — 30 бр']);
  });
});

describe('composeProtocol — order-number reference in the intro (task 7 fix)', () => {
  it('farmer leg cites all order numbers, plural „поръчки №" for 2+', () => {
    const t = composeProtocol(base); // meta.orderNumbers: [101, 102]
    expect(t.intro).toBe('се състави настоящият приемо-предавателен протокол по поръчки № 101, 102 за долуописаните стоки:');
  });

  it('customer leg cites a single order number, singular „поръчка №"', () => {
    const t = composeProtocol({
      ...base,
      kind: 'operator_to_customer',
      meta: { orderNumbers: [101] },
      toSnapshot: { name: 'Иван Петров', phone: '0899', address: 'гр. Варна' },
    });
    expect(t.intro).toBe('се състави настоящата разписка за получена стока по поръчка № 101 за долуописаните стоки:');
  });

  it('farmer leg with no meta falls back to the plain intro (old rows — no dangling „по поръчки №")', () => {
    const { meta, ...noMeta } = base;
    const t = composeProtocol(noMeta);
    expect(t.intro).toBe('се състави настоящият приемо-предавателен протокол за долуописаните стоки:');
  });

  it('customer leg with an empty orderNumbers array falls back to the plain intro', () => {
    const t = composeProtocol({
      ...base,
      kind: 'operator_to_customer',
      meta: { orderNumbers: [] },
      toSnapshot: { name: 'Иван Петров', phone: '0899', address: 'гр. Варна' },
    });
    expect(t.intro).toBe('се състави настоящата разписка за получена стока за долуописаните стоки:');
  });
});

describe('wrap keeps every line inside the content width', () => {
  it('never emits a line wider than CONTENT_W', async () => {
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(readFileSync(join(__dirname, '..', '..', 'assets', 'fonts', 'DejaVuSans.ttf')));
    const long = '„Земеделска кооперация Слънчоглед и партньори" ООД, адрес гр. Русе, бул. Липник 123, ет. 4, ап. 5, тел.: 0888123456, e-mail: office@example.bg';
    for (const line of wrap(long, font, 11, CONTENT_W)) {
      expect(font.widthOfTextAtSize(line, 11)).toBeLessThanOrEqual(CONTENT_W);
    }
  });
});

describe('renderProtocolPdf', () => {
  it('produces a non-empty PDF for a Cyrillic farmer protocol with no signatures', async () => {
    expect(isPdf(await renderProtocolPdf(ROW as any))).toBe(true);
  });

  it('renders the customer receipt', async () => {
    const buf = await renderProtocolPdf({ ...ROW, kind: 'operator_to_customer',
      toSnapshot: { name: 'Иван Петров', phone: '0888', address: 'гр. Русе, ул. Клиент 5' } } as any);
    expect(isPdf(buf)).toBe(true);
  });

  it('renders a row with no meta (back-compat)', async () => {
    const { meta, ...noMeta } = { ...ROW } as any;
    expect(isPdf(await renderProtocolPdf(noMeta))).toBe(true);
  });

  it('falls back to a blank signature line when fromSignaturePng is malformed (no crash)', async () => {
    expect(isPdf(await renderProtocolPdf({ ...ROW, fromSignaturePng: 'not-a-real-data-uri' } as any))).toBe(true);
  });

  it('renders a realistic ~12-item protocol without the signature blocks colliding with the list', async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ productName: `Продукт ${i + 1}`, quantity: i + 1, unit: 'кг' }));
    expect(isPdf(await renderProtocolPdf({ ...ROW, items }))).toBe(true);
  });
});

describe('renderProtocolPdf — overflow (regression)', () => {
  const bigRow = (n: number) => ({
    ...ROW,
    items: Array.from({ length: n }, (_, i) => ({
      productName: `Продукт с доста дълго име номер ${i + 1}`,
      quantity: i + 1,
      unit: 'кг',
    })),
  });

  it('adds pages instead of dropping items off the bottom', async () => {
    const buf = await renderProtocolPdf(bigRow(80) as any);
    expect(isPdf(buf)).toBe(true);
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('still fits a small protocol on a single page', async () => {
    const doc = await PDFDocument.load(await renderProtocolPdf(bigRow(3) as any));
    expect(doc.getPageCount()).toBe(1);
  });
});

describe('renderProtocolPdf — draw-position regression (task 6)', () => {
  // `d.page` is reassigned to a brand-new `PDFPage` instance on every break
  // (see `newPage` in pdf-kit.ts), so spying on the prototype — not one page
  // instance — is the only way to see every draw call across all pages. Same
  // harness as pdf-table.spec.ts / pdf-kit.spec.ts. Page-count assertions
  // (above) prove pagination happened at all; they say nothing about *where*
  // things landed — a renderer could add pages and still draw everything at
  // the same fixed, wrong y. These assert on the actual coordinates pdf-lib
  // received.
  const bigRow = (n: number) => ({
    ...ROW,
    items: Array.from({ length: n }, (_, i) => ({
      productName: `Продукт с доста дълго име номер ${i + 1}`,
      quantity: i + 1,
      unit: 'кг',
    })),
  });

  // ROW.kind is 'farmer_to_operator', so the operator (and hence the brand
  // used for both the header and the footer) is `toSnapshot`.
  const brand = String(ROW.toSnapshot.name);
  const footerText = `Документът е издаден електронно от ${brand}.`;

  let drawTextSpy: jest.SpyInstance;
  let drawLineSpy: jest.SpyInstance;

  beforeEach(() => {
    drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    drawLineSpy = jest.spyOn(PDFPage.prototype, 'drawLine');
  });

  afterEach(() => {
    drawTextSpy.mockRestore();
    drawLineSpy.mockRestore();
  });

  it('never draws body content below MARGIN across a long multi-page protocol — only the pinned footer legitimately sits below it', async () => {
    await renderProtocolPdf(bigRow(80) as any);

    expect(drawTextSpy.mock.calls.length).toBeGreaterThan(0);
    for (const [text, opts] of drawTextSpy.mock.calls) {
      // drawDocumentFooter deliberately pins its text at MARGIN - 18 (see
      // pdf-kit.ts) and does not move the cursor — that is its one legitimate
      // exception to the invariant, so it is the one text excluded here.
      if (text === footerText) continue;
      expect(opts.y).toBeGreaterThanOrEqual(MARGIN);
    }
    for (const [opts] of drawLineSpy.mock.calls) {
      expect(opts.start.y).toBeGreaterThanOrEqual(MARGIN);
      expect(opts.end.y).toBeGreaterThanOrEqual(MARGIN);
    }
  });

  it('keeps every item line strictly above the signature blocks on whichever page they share — the old code clamped signatures to y=150 and let a long list run straight through them', async () => {
    await renderProtocolPdf(bigRow(80) as any);

    const calls = drawTextSpy.mock.calls.map((call, i) => ({
      text: call[0] as string,
      opts: call[1] as { x: number; y: number },
      page: drawTextSpy.mock.instances[i],
    }));

    const sigCalls = calls.filter((c) => c.text.startsWith('ПРЕДАЛ: '));
    expect(sigCalls).toHaveLength(1); // sigBlock draws this label exactly once
    const sigPage = sigCalls[0].page;
    const sigY = sigCalls[0].opts.y;

    // Every numbered item line ("N. Продукт …") drawn on the SAME page as the
    // signature block must sit above it — never sharing or dipping into the
    // vertical band the signature block occupies.
    const itemLinesOnSigPage = calls.filter((c) => c.page === sigPage && /^\d+\.\s/.test(c.text));
    expect(itemLinesOnSigPage.length).toBeGreaterThan(0); // confirm the assertion below isn't vacuous
    for (const c of itemLinesOnSigPage) {
      expect(c.opts.y).toBeGreaterThan(sigY);
    }
  });
});

describe('renderProtocolPdf — signature foot anchor (regression)', () => {
  // Before the pdf-kit retrofit, this line was `Math.min(y - 40, 150)`. The
  // `-40` was load-bearing: `sigBlock` draws the signature PNG at `y + 4`
  // with `height: 36`, so the top edge of the image sits at `sigY + 40`, not
  // just at the label line. The retrofit dropped that to a bare `d.y - 20` —
  // enough clearance for the "ПРЕДАЛ:"/"ПРИЕЛ:" label, but not for the
  // signature image drawn above it. Every short protocol still looked fine
  // (SIG_FOOT_Y anchors those), so the regression only surfaced once the item
  // list pushed content past the anchor (17-18 items on this fixture) — there,
  // the smaller offset let a real signature image land on top of the closing
  // sentence. This block only pins the `sigY` geometry, for which ROW's
  // fixture never draws an image at all (`fromSignaturePng: null`), so it
  // could not have caught that on its own — see the „signature image clears
  // the closing sentence" describe block below, which renders with a real
  // signature PNG and asserts the image never overlaps the text directly.
  // The fix restores the ceiling as `Math.min(d.y - 40, SIG_FOOT_Y)`, kept
  // together with the `ensureSpace(d, 90)` the retrofit added for page-break
  // safety. These values are hand-traced against the real DejaVuSans metrics
  // via a throwaway probe script (not guessed): with the exact `ROW`/`bigRow`
  // fixtures below, sigY is 150 for a short (1-item) protocol (anchor wins,
  // one page), 113 for 18 items (content pushes past the anchor, still one
  // page, no break), and 150 again for 80 items (a page break resets the
  // cursor near the top, so the anchor wins again on the fresh page).
  const SIG_FOOT_Y = 150;

  const bigRow = (n: number) => ({
    ...ROW,
    items: Array.from({ length: n }, (_, i) => ({
      productName: `Продукт с доста дълго име номер ${i + 1}`,
      quantity: i + 1,
      unit: 'кг',
    })),
  });

  let drawTextSpy: jest.SpyInstance;

  beforeEach(() => {
    drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText');
  });

  afterEach(() => {
    drawTextSpy.mockRestore();
  });

  const sigY = (): number => {
    const call = drawTextSpy.mock.calls.find(([text]) => (text as string).startsWith('ПРЕДАЛ: '));
    return (call?.[1] as { y: number }).y;
  };

  it('anchors the signature blocks near the foot of the page for a short protocol, instead of floating directly under the content', async () => {
    await renderProtocolPdf(ROW as any); // ROW: one item — a realistic short protocol.
    expect(sigY()).toBe(SIG_FOOT_Y);
  });

  it('keeps the same foot anchor on the fresh page after a page break, rather than floating near the top of it', async () => {
    const buf = await renderProtocolPdf(bigRow(80) as any);
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBeGreaterThan(1); // confirm this run actually exercises a break
    expect(sigY()).toBe(SIG_FOOT_Y);
  });

  it('tracks below the content instead of the anchor once a single-page item list runs long enough to reach it, while staying above the margin', async () => {
    const buf = await renderProtocolPdf(bigRow(18) as any);
    const doc = await PDFDocument.load(buf);
    expect(doc.getPageCount()).toBe(1); // tight single-page fit, not a break — the anchor-vs-content boundary
    expect(sigY()).toBeLessThan(SIG_FOOT_Y);
    expect(sigY()).toBeGreaterThanOrEqual(MARGIN);
    expect(sigY()).toBe(113);
  });
});

describe('renderProtocolPdf — signature image clears the closing sentence (regression)', () => {
  // The `sigY` pin above is blind to the actual bug: ROW carries
  // `fromSignaturePng: null`, so `sigBlock` never calls `d.page.drawImage` and
  // a test that only inspects `sigY`/text draws can't see an image collide
  // with anything. This fixture supplies a real (tiny, 1x1) signature PNG so
  // `drawImage` actually fires, and asserts the geometric invariant that
  // actually matters on a legal document: the signature image must never be
  // drawn on top of the closing „…се състави в два еднообразни екземпляра…"
  // sentence above it.
  //
  // Verified against the buggy `d.y - 20` this replaces (PDF y grows upward,
  // so a larger image-top value means the image reaches further up the
  // page): at 17 items the image top landed at 189 against a closing-sentence
  // baseline of 184 — 189 > 184, so the image's top edge sat above the
  // sentence's baseline, inside the text's glyph band; at 18 items, 173 vs a
  // baseline of 168 — same overlap. Both are exactly the 17/18-item cases
  // called out in the bug report. With the `-40` fix, the same two cases land
  // at 169-vs-184 and 153-vs-168 — the image top stays at or below the
  // baseline both times, clear of the text.
  const TINY_PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

  const bigRowWithSignature = (n: number) => ({
    ...ROW,
    fromSignaturePng: TINY_PNG,
    items: Array.from({ length: n }, (_, i) => ({
      productName: `Продукт с доста дълго име номер ${i + 1}`,
      quantity: i + 1,
      unit: 'кг',
    })),
  });

  let drawTextSpy: jest.SpyInstance;
  let drawImageSpy: jest.SpyInstance;

  beforeEach(() => {
    drawTextSpy = jest.spyOn(PDFPage.prototype, 'drawText');
    drawImageSpy = jest.spyOn(PDFPage.prototype, 'drawImage');
  });

  afterEach(() => {
    drawTextSpy.mockRestore();
    drawImageSpy.mockRestore();
  });

  /**
   * The closing sentence (`t.footer`, drawn line-by-line by `drawLeft`) is the
   * last thing drawn before `sigBlock` — whose very first action is the
   * "ПРЕДАЛ: ______" label text. So on a single-page render (asserted by the
   * caller), the drawText call immediately before that label is unambiguously
   * the last wrapped line of the closing sentence.
   */
  const lastClosingSentenceY = (): number => {
    const sigIdx = drawTextSpy.mock.calls.findIndex(([text]) => (text as string).startsWith('ПРЕДАЛ: '));
    expect(sigIdx).toBeGreaterThan(0);
    return (drawTextSpy.mock.calls[sigIdx - 1][1] as { y: number }).y;
  };

  it('keeps the signature image at or below the closing sentence at 17 items — the anchor-vs-content boundary', async () => {
    const doc = await PDFDocument.load(await renderProtocolPdf(bigRowWithSignature(17) as any));
    expect(doc.getPageCount()).toBe(1); // single page — footer and signature share it, so the comparison is meaningful

    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    const { y: imgY, height: imgH } = drawImageSpy.mock.calls[0][1] as { y: number; height: number };
    expect(imgY + imgH).toBeLessThanOrEqual(lastClosingSentenceY());
  });

  it('keeps the signature image at or below the closing sentence at 18 items — content has pushed past the SIG_FOOT_Y anchor', async () => {
    const doc = await PDFDocument.load(await renderProtocolPdf(bigRowWithSignature(18) as any));
    expect(doc.getPageCount()).toBe(1);

    expect(drawImageSpy).toHaveBeenCalledTimes(1);
    const { y: imgY, height: imgH } = drawImageSpy.mock.calls[0][1] as { y: number; height: number };
    expect(imgY + imgH).toBeLessThanOrEqual(lastClosingSentenceY());
  });
});
