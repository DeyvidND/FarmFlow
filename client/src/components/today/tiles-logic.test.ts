import { describe, it, expect } from 'vitest';
import {
  prepSubLine,
  routeSubLine,
  protocolsSubLine,
  codSubLine,
  showConfirmAll,
  confirmAllLabel,
  tileHref,
} from './tiles-logic';

describe('tiles-logic', () => {
  it('prepSubLine shows fulfilled/toPrep', () => {
    expect(prepSubLine({ ordersToPrep: 10, fulfilled: 4 })).toBe('4/10 готови');
  });

  it('routeSubLine shows delivered/stops and courier count', () => {
    const sub = routeSubLine({ stops: 12, delivered: 4, pending: 8, couriers: 2 });
    expect(sub).toContain('4/12');
    expect(sub).toContain('2');
  });

  it('protocolsSubLine shows signed/total', () => {
    expect(protocolsSubLine({ total: 4, signed: 1, pending: 3 })).toContain('1/4');
  });

  it('codSubLine renders cash-to-collect in leva', () => {
    const sub = codSubLine({ toCollectStotinki: 12345, toCollectCount: 3, collectedStotinki: 500, collectedCount: 1 });
    expect(sub).toContain('за събиране');
    expect(sub).toContain('събрани');
  });

  it('showConfirmAll is true only with new orders', () => {
    expect(showConfirmAll({ new: 2, confirmed: 1, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 3 })).toBe(true);
    expect(showConfirmAll({ new: 0, confirmed: 3, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 3 })).toBe(false);
  });

  it('confirmAllLabel includes the count', () => {
    expect(confirmAllLabel({ new: 2, confirmed: 0, preparing: 0, outForDelivery: 0, delivered: 0, cancelled: 0, total: 2 })).toContain('2');
  });

  it('tileHref maps each tile to its screen', () => {
    expect(tileHref).toMatchObject({ prep: '/prep', route: '/route', protocols: '/protocols', cod: '/payments' });
  });
});
