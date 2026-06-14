import { BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

// assertMethodAllowed is a pure guard over the tenant's settings.delivery config,
// so we can construct the service with stub deps and call it directly.
describe('OrdersService.assertMethodAllowed', () => {
  const svc = new OrdersService({} as never, {} as never, {} as never, {} as never, {} as never);
  const check = (
    settings: unknown,
    deliveryEnabled: boolean,
    method: string,
    payment: 'online' | 'cod',
  ) =>
    (svc as unknown as {
      assertMethodAllowed: (s: unknown, d: boolean, m: string, p: string) => void;
    }).assertMethodAllowed(settings, deliveryEnabled, method, payment);

  it('pickup always allowed; Econt rejected by default (off)', () => {
    expect(() => check(null, false, 'pickup', 'online')).not.toThrow();
    expect(() => check(null, false, 'econt', 'online')).toThrow(BadRequestException);
    expect(() => check(null, false, 'econt_address', 'online')).toThrow(BadRequestException);
  });

  it('address requires deliveryEnabled (matches the storefront gate)', () => {
    expect(() => check(null, true, 'address', 'online')).not.toThrow();
    // ownSlots defaults on, but deliveryEnabled=false → no local delivery offered.
    expect(() => check(null, false, 'address', 'online')).toThrow(BadRequestException);
  });

  it('rejects a method the farm switched off', () => {
    const settings = { delivery: { methods: { pickup: { enabled: false } } } };
    expect(() => check(settings, true, 'pickup', 'online')).toThrow(BadRequestException);
    // and address off via its own flag even when deliveryEnabled is true
    const noSelf = { delivery: { methods: { ownSlots: { enabled: false } } } };
    expect(() => check(noSelf, true, 'address', 'online')).toThrow(BadRequestException);
  });

  it('allows Econt office once the farm enables it', () => {
    const settings = { delivery: { methods: { econtOffice: { enabled: true } } } };
    expect(() => check(settings, false, 'econt', 'online')).not.toThrow();
  });

  it('rejects COD when the farm disabled наложен платеж', () => {
    const settings = { delivery: { cod: { enabled: false } } };
    expect(() => check(settings, false, 'pickup', 'cod')).toThrow(BadRequestException);
    expect(() => check(settings, false, 'pickup', 'online')).not.toThrow();
  });

  it('COD allowed by default (no config)', () => {
    expect(() => check(null, true, 'address', 'cod')).not.toThrow();
  });
});
