/**
 * Unit test for OrdersService.createCourierOrders() — courier cart split.
 *
 * We spy on the private reserveCartItems so we don't have to re-mock all of its
 * internal product/variant/window queries; it just returns canned prepared items.
 * The DB mock's transaction() runs the callback with a fake tx whose select /
 * insert / execute are jest mocks returning canned rows. We capture the values
 * passed to each orders/orderItems insert so we can assert the split.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { orderItems, orders, shipments } from '@fermeribg/db';
import { OrdersService } from './orders.service';

const TENANT_ID = 'tenant-1';
const FARMER_A = 'farmer-a';
const FARMER_B = 'farmer-b';

/** A prepared cart line as returned by reserveCartItems(). */
function line(farmerId: string | null, productId: string, qty: number, price: number) {
  return {
    productId,
    productName: productId,
    quantity: qty,
    priceStotinki: price,
    variantId: null,
    variantLabel: null,
    farmerId,
  };
}

/** Tenant settings making the given farmer ids courier-ready (Econt configured). */
function settingsReady(...farmerIds: string[]) {
  const farmers: Record<string, unknown> = {};
  for (const id of farmerIds) farmers[id] = { econt: { configured: true } };
  return { delivery: { cod: { enabled: true }, farmers } };
}

const DTO = {
  customerName: 'Иван',
  customerPhone: '0888000000',
  customerEmail: null,
  items: [{ productId: 'p1', quantity: 1 }],
  deliveryAddress: 'ул. Тест 1',
  deliveryCity: 'София',
};

/**
 * Build a fake tx. `farmerRows` is the canned result of the farmers SELECT;
 * `nextNumber` seeds the order-number SELECT. orders insert returns the values
 * it was given plus an id; orderItems insert echoes its values with an id.
 * Captured insert args land in `ordersValues` / `itemsValues` / `shipmentsValues`
 * — branched on which table `insert(table)` was called with.
 */
function makeTx(
  farmerRows: Array<{ id: string; name: string | null; courierEnabled: boolean }>,
  nextNumber: number,
  ordersValues: any[],
  itemsValues: any[],
  shipmentsValues: any[] = [],
) {
  let selectCall = 0;
  const tx: any = {
    select: jest.fn(() => {
      const call = selectCall++;
      const c: any = {};
      c.from = jest.fn(() => c);
      // 1st select → farmers (terminates at .where()); 2nd → nextNumber.
      c.where = jest.fn(() =>
        Promise.resolve(call === 0 ? farmerRows : [{ nextNumber }]),
      );
      return c;
    }),
    execute: jest.fn(() => Promise.resolve([])), // pg_advisory_xact_lock
    insert: jest.fn((table: unknown) => {
      const c: any = {};
      c.values = jest.fn((v: any) => {
        // Branch on the target table: shipments draft (single object) →
        // shipmentsValues; orders (single object) → ordersValues; orderItems
        // (array) → itemsValues.
        if (table === shipments) {
          shipmentsValues.push(v);
          c.__rows = [{ id: `shipment-${shipmentsValues.length}`, ...v }];
        } else if (Array.isArray(v)) {
          itemsValues.push(v);
          c.__rows = v.map((row: any, i: number) => ({ id: `item-${itemsValues.length}-${i}`, ...row }));
        } else {
          ordersValues.push(v);
          c.__rows = [{ id: `order-${ordersValues.length}`, ...v }];
        }
        return c;
      });
      // Draft shipment insert chains .onConflictDoNothing(); make it a no-op
      // terminator that still resolves like .returning() would.
      c.onConflictDoNothing = jest.fn(() => Promise.resolve(c.__rows));
      c.returning = jest.fn(() => Promise.resolve(c.__rows));
      return c;
    }),
  };
  return tx;
}

/** Build the db mock; tenant SELECT (outer) returns one tenant with the settings. */
function buildDb(tx: any, settings: unknown, subscriptionStatus = 'active') {
  return {
    select: jest.fn(() => {
      const c: any = {};
      c.from = jest.fn(() => c);
      c.where = jest.fn(() => c);
      c.limit = jest.fn(() =>
        Promise.resolve([{ id: TENANT_ID, subscriptionStatus, settings }]),
      );
      return c;
    }),
    transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
}

function makeSvc(db: unknown) {
  return new OrdersService(
    db as never,
    { geocode: jest.fn() } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
}

describe('OrdersService.createCourierOrders()', () => {
  it('splits a 2-farmer cart into 2 single-farmer COD orders', async () => {
    const ordersValues: any[] = [];
    const itemsValues: any[] = [];
    const shipmentsValues: any[] = [];
    const tx = makeTx(
      [
        { id: FARMER_A, name: 'Ферма А', courierEnabled: true },
        { id: FARMER_B, name: 'Ферма Б', courierEnabled: true },
      ],
      7, // nextNumber
      ordersValues,
      itemsValues,
      shipmentsValues,
    );
    const db = buildDb(tx, settingsReady(FARMER_A, FARMER_B));
    const svc = makeSvc(db);

    // 2 lines for A (500x2 + 300x1 = 1300), 2 lines for B (100x3 + 200x1 = 500).
    jest.spyOn(svc as any, 'reserveCartItems').mockResolvedValue({
      items: [
        line(FARMER_A, 'a1', 2, 500),
        line(FARMER_A, 'a2', 1, 300),
        line(FARMER_B, 'b1', 3, 100),
        line(FARMER_B, 'b2', 1, 200),
      ],
      slotFrom: null,
      slotTo: null,
      slotDate: null,
    });

    const result = await svc.createCourierOrders('test-farm', DTO as never);

    // Two orders inserted.
    expect(ordersValues).toHaveLength(2);

    const [oA, oB] = ordersValues;
    // Common courier invariants on both orders.
    for (const o of [oA, oB]) {
      expect(o.deliveryType).toBe('courier');
      expect(o.paymentMethod).toBe('cod');
      expect(o.slotId).toBeNull();
      expect(o.carrier).toBeNull();
      expect(o.tenantId).toBe(TENANT_ID);
    }
    // Farmer split key + sequential numbering (first-seen order: A then B).
    expect(oA.farmerId).toBe(FARMER_A);
    expect(oB.farmerId).toBe(FARMER_B);
    expect(oA.orderNumber).toBe(7);
    expect(oB.orderNumber).toBe(8);
    // Per-farmer subtotal — no platform delivery fee.
    expect(oA.totalStotinki).toBe(2 * 500 + 1 * 300); // 1300
    expect(oB.totalStotinki).toBe(3 * 100 + 1 * 200); // 500

    // Returned array: one entry per farmer, farmerName populated.
    expect(result).toHaveLength(2);
    expect(result[0].farmerName).toBe('Ферма А');
    expect(result[1].farmerName).toBe('Ферма Б');
    expect(result[0].items).toHaveLength(2);
    expect(result[1].items).toHaveLength(2);

    // Phase 3 distribution: one DRAFT shipment dropped per order, same tx — keyed
    // to its order, scoped to the order's farmer, COD = the order total.
    expect(tx.insert).toHaveBeenCalledWith(shipments);
    expect(shipmentsValues).toHaveLength(2);
    const [sA, sB] = shipmentsValues;
    for (const s of [sA, sB]) {
      expect(s.tenantId).toBe(TENANT_ID);
      expect(s.status).toBe('draft');
      expect(s.deliveryMode).toBe('address');
      // carrier is OMITTED so the NOT-NULL column defaults to its 'econt'
      // placeholder — 'draft' status is the unshipped marker, not the carrier.
      expect(s.carrier).toBeUndefined();
    }
    // The mock stamps order-N ids in insert order (order-1 = A, order-2 = B).
    expect(sA.orderId).toBe('order-1');
    expect(sA.farmerId).toBe(FARMER_A);
    expect(sA.codAmountStotinki).toBe(2 * 500 + 1 * 300); // 1300 = order A total
    expect(sB.orderId).toBe('order-2');
    expect(sB.farmerId).toBe(FARMER_B);
    expect(sB.codAmountStotinki).toBe(3 * 100 + 1 * 200); // 500 = order B total
  });

  it('throws BadRequestException when a product has no farmer (and inserts nothing)', async () => {
    const ordersValues: any[] = [];
    const itemsValues: any[] = [];
    const tx = makeTx(
      [{ id: FARMER_A, name: 'Ферма А', courierEnabled: true }],
      1,
      ordersValues,
      itemsValues,
    );
    const db = buildDb(tx, settingsReady(FARMER_A));
    const svc = makeSvc(db);

    jest.spyOn(svc as any, 'reserveCartItems').mockResolvedValue({
      items: [line(FARMER_A, 'a1', 1, 500), line(null, 'orphan', 1, 100)],
      slotFrom: null,
      slotTo: null,
      slotDate: null,
    });

    await expect(svc.createCourierOrders('test-farm', DTO as never)).rejects.toThrow(
      BadRequestException,
    );
    expect(tx.insert).not.toHaveBeenCalled();
    expect(ordersValues).toHaveLength(0);
  });

  it('throws BadRequestException when a cart farmer is not courier-ready (and inserts nothing)', async () => {
    const ordersValues: any[] = [];
    const itemsValues: any[] = [];
    const tx = makeTx(
      [
        { id: FARMER_A, name: 'Ферма А', courierEnabled: true },
        // Farmer B exists but is NOT ready (courierEnabled false + no configured carrier).
        { id: FARMER_B, name: 'Ферма Б', courierEnabled: false },
      ],
      1,
      ordersValues,
      itemsValues,
    );
    // settings only mark A as ready (B has no namespace).
    const db = buildDb(tx, settingsReady(FARMER_A));
    const svc = makeSvc(db);

    jest.spyOn(svc as any, 'reserveCartItems').mockResolvedValue({
      items: [line(FARMER_A, 'a1', 1, 500), line(FARMER_B, 'b1', 1, 100)],
      slotFrom: null,
      slotTo: null,
      slotDate: null,
    });

    await expect(svc.createCourierOrders('test-farm', DTO as never)).rejects.toThrow(
      'Един от фермерите не предлага куриерска доставка.',
    );
    expect(tx.insert).not.toHaveBeenCalled();
    expect(ordersValues).toHaveLength(0);
  });

  it('throws BadRequestException before the transaction when COD is disabled', async () => {
    const ordersValues: any[] = [];
    const itemsValues: any[] = [];
    const tx = makeTx(
      [{ id: FARMER_A, name: 'Ферма А', courierEnabled: true }],
      1,
      ordersValues,
      itemsValues,
    );
    // COD explicitly disabled.
    const db = buildDb(tx, { delivery: { cod: { enabled: false }, farmers: {} } });
    const svc = makeSvc(db);
    const spy = jest.spyOn(svc as any, 'reserveCartItems');

    await expect(svc.createCourierOrders('test-farm', DTO as never)).rejects.toThrow(
      BadRequestException,
    );
    // Bailed before opening the transaction.
    expect(db.transaction).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when the farm slug is unknown', async () => {
    const db = {
      select: jest.fn(() => {
        const c: any = {};
        c.from = jest.fn(() => c);
        c.where = jest.fn(() => c);
        c.limit = jest.fn(() => Promise.resolve([])); // no tenant
        return c;
      }),
      transaction: jest.fn(),
    };
    const svc = makeSvc(db);

    await expect(svc.createCourierOrders('nope', DTO as never)).rejects.toThrow(
      NotFoundException,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });
});
