import { ConsolidationService } from './consolidation.service';

function makeDb(deliveryCfg: unknown) {
  // Minimal drizzle-select stub: returns the tenant settings row for the cfg read.
  return {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => [{ settings: { delivery: deliveryCfg } }] }),
      }),
    }),
  } as any;
}

describe('ConsolidationService.getSuggestions gating', () => {
  it('returns empty when the toggle is off', async () => {
    const svc = new ConsolidationService(makeDb({ consolidateCourier: false }));
    await expect(svc.getSuggestions('t1')).resolves.toEqual({ suggestions: [] });
  });
});
