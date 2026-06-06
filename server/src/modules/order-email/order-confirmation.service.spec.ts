import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrderConfirmationService } from './order-confirmation.service';

/**
 * Thenable chainable Drizzle mock: every builder method returns the same object,
 * and awaiting it resolves the next queued result — so each query in
 * sendForOrder (order → tenant → items → products → media) pulls one entry.
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

describe('OrderConfirmationService.sendForOrder', () => {
  it('sends a styled confirmation with items, photos, euro totals + order number', async () => {
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

    await svc.sendForOrder('order-uuid-1');

    expect(email.sendMail).toHaveBeenCalledTimes(1);
    const arg = email.sendMail.mock.calls[0][0];
    expect(arg.to).toBe('buyer@example.com');
    expect(arg.stream).toBe('transactional');
    expect(arg.subject).toContain('№42');
    expect(arg.html).toContain('Одит Ябълки');
    expect(arg.html).toContain('cdn.example.com/apple.jpg'); // product photo
    expect(arg.html).toContain('13,48 €'); // grand total
    expect(arg.html).toContain('9,98 €'); // subtotal (2×4,99)
    expect(arg.html).toContain('3,50 €'); // shipping (1348−998)
    expect(arg.html).toContain('Иван Купувач');
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

    await svc.sendForOrder('order-uuid-1');
    expect(email.sendMail.mock.calls[0][0].html).toContain('cdn.example.com/cover.jpg');
  });

  it('no-ops (no send) when the order has no customer email', async () => {
    const email = makeEmail();
    const svc = build([[{ ...ORDER, customerEmail: null }]], email);
    await svc.sendForOrder('order-uuid-1');
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('no-ops when the order is not found', async () => {
    const email = makeEmail();
    const svc = build([[]], email);
    await svc.sendForOrder('missing');
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('never throws — a send failure is swallowed', async () => {
    const email = makeEmail();
    email.sendMail.mockRejectedValueOnce(new Error('smtp down'));
    const svc = build(
      [
        [ORDER],
        [{ name: 'Ферма Петрови' }],
        [{ productId: 'p1', name: 'X', quantity: 1, priceStotinki: 100 }],
        [{ id: 'p1', imageUrl: null, tint: null }],
        [],
      ],
      email,
    );
    await expect(svc.sendForOrder('order-uuid-1')).resolves.toBeUndefined();
  });
});
