import { ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';

// A producer sub-account may mark its OWN COD order as «delivered» (= cash
// received) from the Плащания screen, but nothing else — confirming/cancelling
// stays owner-only. The transition guard runs before any DB access, so we can
// exercise it with stub deps (mirrors orders.method-guard.spec).
describe('OrdersService.updateStatusForFarmer transition guard', () => {
  const svc = new OrdersService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

  it('rejects any transition other than «delivered» for a producer', async () => {
    for (const status of ['confirmed', 'preparing', 'out_for_delivery', 'cancelled', 'pending']) {
      await expect(
        svc.updateStatusForFarmer('o', 't', 'farmer-1', { status } as never),
      ).rejects.toThrow(ForbiddenException);
    }
  });
});
