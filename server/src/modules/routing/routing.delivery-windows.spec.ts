import { RoutingService } from './routing.service';

// ---------------------------------------------------------------------------
// Shared mocked-db chain, mirroring routing.courier-default.spec.ts /
// routing.adversarial.spec.ts's style: successive select() calls consume the
// next pre-loaded result; the chain itself is "thenable" so a query that never
// calls .orderBy()/.limit() (e.g. the order-items lookup) still awaits fine.
// update() is tracked so tests can assert HOW MANY orders were written,
// without needing to inspect the drizzle `eq()`/`and()` where-expression
// internals.
// ---------------------------------------------------------------------------
function makeDb(selectResults: any[][]) {
  const results = [...selectResults];
  let updateCount = 0;
  const db = {
    select: () => {
      const result = results.length ? results.shift()! : [];
      const chain: any = {
        from: () => chain,
        leftJoin: () => chain,
        where: () => chain,
        orderBy: () => Promise.resolve(result),
        limit: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
    update: () => ({
      set: () => {
        updateCount++;
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    get __updateCount() {
      return updateCount;
    },
  } as any;
  return db;
}

const geoOrder = (
  id: string,
  lat: number,
  lng: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  customer: null,
  phone: null,
  email: 'client@test.bg',
  address: `адрес ${id}`,
  note: null,
  lat: String(lat),
  lng: String(lng),
  ...extra,
});

// ─── (a) persisted manual order (route_seq) wins over the optimizer ────────
describe('RoutingService.getRoute — route_seq honoured over re-optimization', () => {
  it('sorts by route_seq even when the maps-optimize mock would reorder differently', async () => {
    // A "hostile" optimizer that reverses whatever it's given — if the service
    // ever called it for this group, the order would come back reversed
    // instead of the persisted sequence.
    const route = jest.fn(async (_o: any, pts: any[]) => ({
      order: pts.map((_: any, i: number) => pts.length - 1 - i),
      distanceM: 1000,
      durationS: 600,
      polyline: 'g',
    }));
    const maps = {
      route,
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 900, durationS: 600, polyline: 'r' }),
      geocode: jest.fn(),
    } as any;

    const TENANT = {
      farmAddress: 'Ферма',
      farmLat: '43.17',
      farmLng: '27.84',
      settings: { routing: {} },
    };
    // A (seq 2), B (seq 0), C (seq 1) — persisted visit order is B, C, A.
    const rows = [
      geoOrder('A', 43.24, 27.9, { routeSeq: 2 }),
      geoOrder('B', 43.2, 27.95, { routeSeq: 0 }),
      geoOrder('C', 43.16, 27.9, { routeSeq: 1 }),
    ];
    const db = makeDb([[TENANT], rows, []]);
    const svc = new RoutingService(db, maps, {} as any, {} as any);

    const result = await svc.getRoute('t1', '2026-07-07');

    expect(result.routes).toHaveLength(1);
    expect(result.routes[0].stops.map((s) => s.id)).toEqual(['B', 'C', 'A']);
    // preserveOrder skips the Google optimizer entirely for a sequenced group.
    expect(route).not.toHaveBeenCalled();
  });

  it('leaves an un-sequenced group to the normal optimizer', async () => {
    const route = jest.fn(async (_o: any, pts: any[]) => ({
      order: pts.map((_: any, i: number) => i),
      distanceM: 1000,
      durationS: 600,
      polyline: 'g',
    }));
    const maps = {
      route,
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 900, durationS: 600, polyline: 'r' }),
      geocode: jest.fn(),
    } as any;
    const TENANT = {
      farmAddress: 'Ферма',
      farmLat: '43.17',
      farmLng: '27.84',
      settings: { routing: {} },
    };
    const rows = [geoOrder('A', 43.24, 27.9), geoOrder('B', 43.2, 27.95)];
    const db = makeDb([[TENANT], rows, []]);
    const svc = new RoutingService(db, maps, {} as any, {} as any);

    await svc.getRoute('t1', '2026-07-07');

    expect(route).toHaveBeenCalled();
  });
});

// ─── (b) regenerate must not clobber an already-SENT, unchanged window ──────
describe('RoutingService.generateDeliveryWindows — sent windows are not clobbered', () => {
  it('leaves a sent+unchanged window alone but resets a sent+changed one to draft', async () => {
    // No farm origin → the fallback per-leg timing branch applies, which is
    // deterministic regardless of stop order (both stops land in the same
    // 09:00–10:00 slot with the default day-start/slot-size settings), so this
    // test isn't sensitive to which stop the greedy fallback visits first.
    const TENANT = {
      farmAddress: null,
      farmLat: null,
      farmLng: null,
      settings: { routing: {} },
    };
    const rowUnchanged = geoOrder('X', 43.0, 23.0, {
      windowStatus: 'sent',
      windowStart: '09:00',
      windowEnd: '10:00',
    });
    const rowChanged = geoOrder('Y', 43.01, 23.01, {
      windowStatus: 'sent',
      windowStart: '08:00',
      windowEnd: '09:00',
    });
    const db = makeDb([[TENANT], [rowUnchanged, rowChanged], [], [TENANT]]);
    const maps = { route: jest.fn(), routeFixed: jest.fn(), geocode: jest.fn() } as any;
    const svc = new RoutingService(db, maps, {} as any, {} as any);

    const proposal = await svc.generateDeliveryWindows('t1', '2026-07-07');

    // Both stops compute to the same 09:00–10:00 window (see comment above).
    for (const stop of proposal.couriers[0].stops) {
      expect(stop.windowStart).toBe('09:00');
      expect(stop.windowEnd).toBe('10:00');
    }
    // Only Y (whose existing sent window differs from the recomputed one) is
    // written — X (sent, unchanged) is left alone, not reset to 'draft'.
    expect(db.__updateCount).toBe(1);
  });
});

// ─── (c) return-leg no longer excluded from the per-stop time-share denominator ─
describe('RoutingService.generateDeliveryWindows — return-leg timing fix', () => {
  it("does not inflate the only stop's window with the full round-trip drive time", async () => {
    const TENANT = {
      farmAddress: 'Ферма',
      farmLat: '43.0',
      farmLng: '23.0',
      settings: { routing: { dayStartHour: 9, slotSizeMin: 15, serviceMin: 0 } },
    };
    const row = geoOrder('S1', 43.01, 23.0);
    const db = makeDb([[TENANT], [row], [], [TENANT]]);
    // A single-stop, non-reordered, 'home' (round-trip) leg: Google's own
    // numbers (20 min total) are reused as-is (precomputedTotal), so driveMin
    // is deterministic regardless of the actual haversine distances chosen.
    const maps = {
      route: jest.fn().mockResolvedValue({ order: [0], distanceM: 5000, durationS: 1200, polyline: 'g' }),
      routeFixed: jest.fn().mockResolvedValue({ distanceM: 5000, durationS: 1200, polyline: 'g' }),
      geocode: jest.fn(),
    } as any;
    const svc = new RoutingService(db, maps, {} as any, {} as any);

    const proposal = await svc.generateDeliveryWindows('t1', '2026-07-07');

    // Origin→stop distance D and stop→home(=origin) distance are identical
    // (same two points, symmetric haversine) — so a route WITH a return leg
    // (endMode 'home', the default) splits the 20-minute measured duration
    // 50/50: 10 minutes to reach the only stop, not the full 20 the pre-fix
    // ratio (cumDist/onewayDist = 1.0) would have given it. 9:00 + 10min,
    // floored to the 15-min grid, is still the 09:00–09:15 slot; the bugged
    // (inflated, +20min) version would land one slot later (09:15–09:30).
    expect(proposal.couriers[0].stops[0].windowStart).toBe('09:00');
    expect(proposal.couriers[0].stops[0].windowEnd).toBe('09:15');
  });
});

// ─── (d) notify continues past one send failure ────────────────────────────
describe('RoutingService.notifyDeliveryWindows — partial-failure resilience', () => {
  it('continues past a failed send, reports it, and does not mark that order sent', async () => {
    const rows = [
      { id: 'o1', email: 'a@test.bg', windowStart: '09:00', windowEnd: '10:00' },
      { id: 'o2', email: 'b@test.bg', windowStart: '10:00', windowEnd: '11:00' },
    ];
    // Record every update's SET payload so we can distinguish claim / mark-sent /
    // release. Every claim wins the race in this single-run test.
    const sets: Record<string, unknown>[] = [];
    const db = {
      select: () => {
        const chain: any = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => Promise.resolve(rows),
          then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
      update: () => ({
        set: (vals: Record<string, unknown>) => {
          sets.push(vals);
          return {
            where: () => ({
              // The claim chains .returning(); a won claim returns one row.
              returning: () => Promise.resolve([{ id: 'claimed' }]),
              // mark-sent / release just await the where().
              then: (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject),
            }),
          };
        },
      }),
    } as any;
    const orderEmail = {
      sendDeliveryWindow: jest
        .fn()
        .mockRejectedValueOnce(new Error('smtp down'))
        .mockResolvedValueOnce(undefined),
    };
    const svc = new RoutingService(db, {} as any, {} as any, orderEmail as any);

    const result = await svc.notifyDeliveryWindows('t1', '2026-07-07');

    expect(result).toEqual({ sent: 1, skipped: 0, failed: 1, total: 2, date: '2026-07-07' });
    expect(orderEmail.sendDeliveryWindow).toHaveBeenCalledTimes(2);
    // Exactly one order was marked 'sent' (the successful o2).
    expect(sets.filter((s) => s.deliveryWindowStatus === 'sent')).toHaveLength(1);
    // The failed order (o1) had its claim released (notifiedAt → null) so a later
    // run can retry it — never left claimed-but-unsent.
    expect(sets.filter((s) => s.deliveryWindowNotifiedAt === null)).toHaveLength(1);
    // Two claims (one per row), each stamping notifiedAt with a Date.
    expect(sets.filter((s) => s.deliveryWindowNotifiedAt instanceof Date)).toHaveLength(2);
  });

  it('skips a row it cannot claim (a concurrent run already owns it)', async () => {
    const rows = [{ id: 'o1', email: 'a@test.bg', windowStart: '09:00', windowEnd: '10:00' }];
    const db = {
      select: () => {
        const chain: any = {
          from: () => chain,
          leftJoin: () => chain,
          where: () => Promise.resolve(rows),
          then: (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject),
        };
        return chain;
      },
      update: () => ({
        set: () => ({
          where: () => ({
            // Lost the race — the compare-and-set updated no row.
            returning: () => Promise.resolve([]),
            then: (resolve: any, reject: any) => Promise.resolve(undefined).then(resolve, reject),
          }),
        }),
      }),
    } as any;
    const orderEmail = { sendDeliveryWindow: jest.fn() };
    const svc = new RoutingService(db, {} as any, {} as any, orderEmail as any);

    const result = await svc.notifyDeliveryWindows('t1', '2026-07-07');

    expect(result).toEqual({ sent: 0, skipped: 1, failed: 0, total: 1, date: '2026-07-07' });
    // Never sent — the row was already claimed elsewhere.
    expect(orderEmail.sendDeliveryWindow).not.toHaveBeenCalled();
  });
});
