import { ForbiddenException } from '@nestjs/common';
import { OrdersService } from './orders.service';

/** Flattens a drizzle `SQL` object's (possibly nested) queryChunks into the
 *  literal SQL text it was built from — enough to assert a WHERE clause
 *  contains a given fragment without a live DB (mirrors
 *  basket-revenue-overrides.spec.ts's helper of the same name). */
function literalText(node: unknown): string {
  const n = node as { queryChunks?: unknown[]; value?: unknown } | null;
  if (!n || typeof n !== 'object') return '';
  if (Array.isArray(n.value) && n.value.every((v) => typeof v === 'string')) {
    return (n.value as string[]).join('');
  }
  if (Array.isArray(n.queryChunks)) return n.queryChunks.map(literalText).join('');
  return '';
}

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

  // Finding #2: a basket's own PARENT row always carries farmerId=null (the
  // basket product has no farmer). Without excluding it, its `lineItems` query
  // would resolve `{farmerId: null}` for the parent alongside the producer's
  // OWN farmerId for every child — `.some(li => li.farmerId !== farmerId)`
  // would see the null and reject a single-farmer basket as "shared with
  // another producer", 403-ing a producer who owns every member. The WHERE
  // clause itself must exclude that row (NOT_BASKET_PARENT in orders.service.ts)
  // — captured here rather than trusted, since a passthrough mock (as used by
  // every other test in this file) cannot see whether the real query filters
  // it out.
  it('excludes a basket\'s own parent row from the ownership WHERE clause', async () => {
    const wheres: unknown[] = [];
    const chain: any = {};
    chain.select = jest.fn(() => chain);
    chain.from = jest.fn(() => chain);
    chain.innerJoin = jest.fn(() => chain);
    chain.where = jest.fn((w: unknown) => {
      wheres.push(w);
      return Promise.resolve([{ farmerId: 'farmer-1' }]);
    });
    const svc = new OrdersService(
      chain as never, {} as never, {} as never, {} as never,
      {} as never, {} as never, {} as never, {} as never,
    );
    jest.spyOn(svc as never as { updateStatus: (...a: unknown[]) => unknown }, 'updateStatus')
      .mockResolvedValue({ id: 'o' } as never);

    await svc.updateStatusForFarmer('o', 't', 'farmer-1', { status: 'delivered' } as never);

    const rendered = literalText(wheres[0]);
    expect(rendered).toMatch(/bundle/i);
    expect(rendered).toMatch(/is null/i);
    expect(rendered).toMatch(/not\s*\(/i);
  });
});

// Task C3 — a driver (courier login) may finish a delivery or undo an
// accidental finish from the route screen, and nothing else. No DB access
// before the transition guard (unlike updateStatusForFarmer, this method does
// NOT check route-leg ownership — see the doc comment on the method), so we
// can exercise it with stub deps.
describe('OrdersService.updateStatusForCourier transition guard', () => {
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

  it('rejects any transition other than «delivered»/«confirmed»', async () => {
    for (const status of ['preparing', 'out_for_delivery', 'cancelled', 'pending']) {
      await expect(
        svc.updateStatusForCourier('o', 't', { status } as never),
      ).rejects.toThrow(ForbiddenException);
    }
  });

  it('delegates «delivered» to updateStatus', async () => {
    const spy = jest
      .spyOn(svc as never as { updateStatus: (...a: unknown[]) => unknown }, 'updateStatus')
      .mockResolvedValue({ id: 'o' } as never);
    await svc.updateStatusForCourier('o', 't', { status: 'delivered' } as never);
    expect(spy).toHaveBeenCalledWith('o', 't', { status: 'delivered' });
  });

  it('delegates «confirmed» (undo-finish) to updateStatus', async () => {
    const spy = jest
      .spyOn(svc as never as { updateStatus: (...a: unknown[]) => unknown }, 'updateStatus')
      .mockResolvedValue({ id: 'o' } as never);
    await svc.updateStatusForCourier('o', 't', { status: 'confirmed' } as never);
    expect(spy).toHaveBeenCalledWith('o', 't', { status: 'confirmed' });
  });
});
