import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderConfirmationService } from './order-confirmation.service';

/**
 * Thenable chainable Drizzle mock: every builder method returns the same object,
 * and awaiting it resolves the next queued result — so each query in
 * buildReceivedEmail (order → tenant → items → products → media) pulls one entry.
 */
function makeDb(queue: unknown[]) {
  let i = 0;
  const db: any = {};
  const chain = () => db;
  for (const k of [
    'select', 'from', 'where', 'limit', 'orderBy', 'leftJoin', 'innerJoin',
  ]) {
    db[k] = jest.fn(chain);
  }
  db.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(queue[i++] ?? []).then(res, rej);
  return db;
}

function makeEmail() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}
const config = { get: () => 'http://localhost:3003' } as unknown as ConfigService;

function build(queue: unknown[], email: ReturnType<typeof makeEmail>) {
  jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  return new OrderConfirmationService(makeDb(queue) as never, email as never, config);
}

const ORDER = {
  id: 'order-uuid-1',
  tenantId: 'tenant-1',
  orderNumber: 42,
  customerName: 'Иван Купувач',
  customerEmail: 'buyer@example.com',
  deliveryType: 'econt',
  econtOffice: '1127',
  deliveryAddress: null,
  deliveryCity: null,
  totalStotinki: 1348, // 2×499 + 350 shipping
};

/** buildReceivedEmail RENDERS the buyer's one mail (received + разписка) but
 *  never sends — OrderProtocolEmailService attaches the PDF and delivers. */
describe('OrderConfirmationService.buildReceivedEmail', () => {
  it('builds the styled received email with items, photos and euro totals, without an order number', async () => {
    const email = makeEmail();
    const svc = build(
      [
        [ORDER], // order
        [{ name: 'Ферма Петрови' }], // tenant
        [{ productId: 'p1', name: 'Одит Ябълки', quantity: 2, priceStotinki: 499 }], // items
        [{ id: 'p1', imageUrl: 'https://cdn.example.com/apple.jpg', tint: '#D94A4A' }], // products
        [], // product media
      ],
      email,
    );

    const arg = await svc.buildReceivedEmail('order-uuid-1');

    expect(arg).not.toBeNull();
    // Renders only — the single send (with the разписка attachment) belongs
    // to OrderProtocolEmailService.
    expect(email.sendMail).not.toHaveBeenCalled();
    expect(arg!.to).toBe('buyer@example.com');
    expect(arg!.subject).toContain('Получихме поръчката ти');
    expect(arg!.subject).toContain('Ферма Петрови');
    // The order number is intentionally hidden from the buyer (a sequential №N
    // would reveal the shop's order count), so it appears in neither subject nor body.
    expect(arg!.subject).not.toContain('42');
    expect(arg!.html).not.toContain('№42');
    expect(arg!.html).toContain('Одит Ябълки');
    expect(arg!.html).toContain('cdn.example.com/apple.jpg'); // product photo
    expect(arg!.html).toContain('13,48 €'); // grand total
    expect(arg!.html).toContain('9,98 €'); // subtotal (2×4,99)
    expect(arg!.html).toContain('3,50 €'); // shipping (1348−998)
    expect(arg!.html).toContain('Иван Купувач');
    // The body announces the attached разписка — this is the buyer's ONE mail.
    expect(arg!.html).toContain('разписка');
  });

  it('falls back to the gallery cover when the product has no legacy imageUrl', async () => {
    const email = makeEmail();
    const svc = build(
      [
        [ORDER],
        [{ name: 'Ферма Петрови' }],
        [{ productId: 'p1', name: 'Череши', quantity: 1, priceStotinki: 600 }],
        [{ id: 'p1', imageUrl: null, tint: '#A11E2E' }],
        [{ productId: 'p1', url: 'https://cdn.example.com/cover.jpg', position: 0 }],
      ],
      email,
    );

    const arg = await svc.buildReceivedEmail('order-uuid-1');
    expect(arg!.html).toContain('cdn.example.com/cover.jpg');
  });

  // Finding #4: a basket child order_items row is stored priced at 0 (the
  // parent line right above it already carries the basket's full price).
  // Before this fix the item rows were rendered with no basket awareness at
  // all — a child printed as "Домати × 3 · 0,00 €" / "0,00 €", reading as a
  // free product. Match the panel's "в кошницата" treatment
  // (order-panel.tsx) instead — no price at all on a child's line, in both
  // the HTML and the plain-text body.
  it('renders a basket child as "в кошницата", never as a 0,00 € line', async () => {
    const email = makeEmail();
    const svc = build(
      [
        [{ ...ORDER, totalStotinki: 3990 }], // order — the basket's own fixed price
        [{ name: 'Ферма Петрови' }], // tenant
        [
          { productId: 'basket-1', name: 'Кошница', quantity: 1, priceStotinki: 3990, bundleParentId: null },
          { productId: 'tomato-1', name: 'Домати', quantity: 2, priceStotinki: 0, bundleParentId: 'item-basket-1' },
          { productId: 'cheese-1', name: 'Сирене', quantity: 1, priceStotinki: 0, bundleParentId: 'item-basket-1' },
        ], // items
        [
          { id: 'basket-1', imageUrl: null, tint: '#2d6a4f' },
          { id: 'tomato-1', imageUrl: null, tint: '#B33' },
          { id: 'cheese-1', imageUrl: null, tint: '#EEA' },
        ], // products
        [], // product media
      ],
      email,
    );

    const { html, text } = (await svc.buildReceivedEmail('order-uuid-1'))!;
    expect(html).toContain('Домати');
    expect(html).toContain('Сирене');
    expect(html).toContain('в кошницата');
    // A child's line must never render its (zero) price as a real money amount.
    expect(html).not.toMatch(/Домати[\s\S]{0,80}0,00\s*€/);
    expect(html).not.toMatch(/Сирене[\s\S]{0,80}0,00\s*€/);
    expect(text).toContain('Домати × 2 (в кошницата)');
    expect(text).toContain('Сирене × 1 (в кошницата)');
    expect(text).not.toContain('Домати × 2 = 0,00 €');
    // The basket's own (parent) line keeps its real price, untouched.
    expect(html).toContain('39,90 €');
  });

  it('returns null when the order has no customer email', async () => {
    const email = makeEmail();
    const svc = build([[{ ...ORDER, customerEmail: null }]], email);
    await expect(svc.buildReceivedEmail('order-uuid-1')).resolves.toBeNull();
  });

  it('returns null when the order is not found', async () => {
    const email = makeEmail();
    const svc = build([[]], email);
    await expect(svc.buildReceivedEmail('missing')).resolves.toBeNull();
  });
});
