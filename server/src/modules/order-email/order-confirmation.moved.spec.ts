import { OrderConfirmationService } from './order-confirmation.service';

/** db whose selects resolve, in order: [order], [tenant]. */
function svc(order: Record<string, unknown> | undefined, tenant: Record<string, unknown>) {
  let call = 0;
  const chain: any = {};
  chain.from = () => chain;
  chain.where = () => chain;
  chain.limit = () => Promise.resolve(call++ === 0 ? (order ? [order] : []) : [tenant]);
  const db: any = { select: () => chain };
  const email = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const config: any = { get: () => 'https://shop.example' };
  return { s: new OrderConfirmationService(db, email as any, config), email };
}

const ORDER = {
  id: 'o1', tenantId: 't1', customerEmail: 'buyer@example.com', customerName: 'Иван',
  deliveryType: 'address', deliveryAddress: 'ул. Стара 1', deliveryCity: null,
  econtOffice: null, totalStotinki: 2450,
};
const TENANT = { name: 'Зелена ферма', settings: { contact: { phone: '0888123456' } } };

describe('OrderConfirmationService.sendMoved', () => {
  it('sends a from→to email with the farm phone', async () => {
    const { s, email } = svc(ORDER, TENANT);
    await s.sendMoved('o1', '2026-07-09', '2026-07-10');
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    const arg = email.sendMail.mock.calls[0][0];
    expect(arg.to).toBe('buyer@example.com');
    expect(arg.subject).toContain('Промяна в деня на доставка');
    expect(arg.html).toContain('0888123456');
    expect(arg.stream).toBe('transactional');
  });

  it('does not send when the order has no email', async () => {
    const { s, email } = svc({ ...ORDER, customerEmail: null }, TENANT);
    await s.sendMoved('o1', '2026-07-09', '2026-07-10');
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('omits the phone clause gracefully when the farm has no phone', async () => {
    const { s, email } = svc(ORDER, { name: 'Ф', settings: {} });
    await s.sendMoved('o1', null, '2026-07-10');
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    expect(email.sendMail.mock.calls[0][0].html).not.toContain('обади се на');
  });
});
