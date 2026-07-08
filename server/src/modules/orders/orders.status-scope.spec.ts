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

// «delivered» flips COD-collected for the WHOLE order, so a producer may only close
// out an order that is entirely their own — never a shared multi-producer order.
describe('OrdersService.updateStatusForFarmer ownership (multi-producer) guard', () => {
  function makeSvc(lineItems: Array<{ farmerId: string | null }>) {
    const chain: any = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.where = jest.fn(() => Promise.resolve(lineItems));
    return new OrdersService(
      chain as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
  }

  it('rejects «delivered» on a shared order with a co-producer line item', async () => {
    const svc = makeSvc([{ farmerId: 'farmer-1' }, { farmerId: 'farmer-2' }]);
    await expect(
      svc.updateStatusForFarmer('o', 't', 'farmer-1', { status: 'delivered' } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('rejects «delivered» when no line items resolve (cross-tenant / not theirs)', async () => {
    const svc = makeSvc([]);
    await expect(
      svc.updateStatusForFarmer('o', 't', 'farmer-1', { status: 'delivered' } as never),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows «delivered» when every line item belongs to the producer', async () => {
    const svc = makeSvc([{ farmerId: 'farmer-1' }, { farmerId: 'farmer-1' }]);
    const spy = jest
      .spyOn(svc as never as { updateStatus: (...a: unknown[]) => unknown }, 'updateStatus')
      .mockResolvedValue({ id: 'o' } as never);
    await svc.updateStatusForFarmer('o', 't', 'farmer-1', { status: 'delivered' } as never);
    expect(spy).toHaveBeenCalledWith('o', 't', { status: 'delivered' });
  });
});
