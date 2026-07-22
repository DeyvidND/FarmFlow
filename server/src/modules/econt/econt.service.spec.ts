import { PDFDocument } from 'pdf-lib';
import { EcontService } from './econt.service';
import { mapShipmentRow, mapTrackingEvents, mergePdfs, parseCodReconciliation, shouldNotifyShipped, buildManualOrderShape, mapManualShipmentRow, parseAddressValidation, slimClientProfiles, buildCourierRequest } from './econt.mappers';
import { deriveSenderFromFarm } from './econt.sender';
import { consolidatedCodOverride } from '../econt-app/consolidation.helpers';


describe('EcontService.codAmountFor', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  const cod = (order: Record<string, unknown>): number | null =>
    (svc as unknown as { codAmountFor: (o: unknown) => number | null }).codAmountFor(order);

  it('unpaid COD order → the order total in stotinki', () => {
    expect(cod({ paymentMethod: 'cod', totalStotinki: 2400 })).toBe(2400);
  });
  it('online order → null', () => {
    expect(cod({ paymentMethod: 'online', totalStotinki: 2400 })).toBeNull();
  });
  it('COD already paid online → null (no second collection)', () => {
    expect(cod({ paymentMethod: 'cod', totalStotinki: 2400, paidAt: new Date() })).toBeNull();
  });
});

describe('consolidated master COD wins over order total', () => {
  it('uses the master shipment group sum, not codAmountFor(order)', () => {
    // The order total is the collector's own share (500); the master shipment holds
    // the whole group's COD (1800). The waybill must collect 1800.
    const masterDraft = { id: 'm', consolidationGroupId: 'm', codAmountStotinki: 1800 };
    const orderShare = 500;
    const cod = consolidatedCodOverride(masterDraft) ?? orderShare;
    expect(cod).toBe(1800);
  });
});

describe('mapShipmentRow', () => {
  /** Minimal Econt join-row fixture — all new carrier columns null (legacy). */
  const econtBase = {
    carrier: null as string | null,
    orderCarrier: null as string | null,
    trackingNumber: null as string | null,
    carrierShipmentId: null as string | null,
  };

  it('passes labelPdfUrl, codAmount and a created status through', () => {
    const out = mapShipmentRow({
      orderId: '11111111-2222-3333-4444-555555555555',
      customerName: 'Иван',
      deliveryType: 'econt',
      total: 2400,
      shipmentId: 'aaaa',
      shipmentNumber: '1051000000001',
      shipmentStatus: 'created',
      courierPrice: 599,
      labelPdfUrl: 'https://ee.econt.com/x.pdf',
      codAmount: 2400,
      trackingJson: null,
      ...econtBase,
    });
    expect(out.orderNumber).toBe('11111111');
    expect(out.method).toBe('econtOffice');
    expect(out.status).toBe('created');
    expect(out.trackingNumber).toBe('1051000000001');
    expect(out.priceStotinki).toBe(599);
    expect(out.codAmountStotinki).toBe(2400);
    expect(out.labelPdfUrl).toBe('https://ee.econt.com/x.pdf');
    expect(out.history).toEqual([]);
    // Legacy Econt row with no carrier column → defaults to 'econt'.
    expect(out.carrier).toBe('econt');
  });

  it('door delivery → econtAddress method', () => {
    const out = mapShipmentRow({
      orderId: '22222222-3333-4444-5555-666666666666',
      customerName: 'Мария',
      deliveryType: 'econt_address',
      total: 5000,
      shipmentId: 'bbbb',
      shipmentNumber: '1051000000002',
      shipmentStatus: 'created',
      courierPrice: null,
      labelPdfUrl: null,
      codAmount: null,
      trackingJson: null,
      ...econtBase,
    });
    expect(out.method).toBe('econtAddress');
    // courierPrice null → falls back to order total.
    expect(out.priceStotinki).toBe(5000);
    expect(out.labelPdfUrl).toBeUndefined();
    expect(out.codAmountStotinki).toBeUndefined();
  });

  it('courier order → econtAddress method (courier IS door delivery, not an office)', () => {
    const out = mapShipmentRow({
      orderId: '77777777-8888-9999-aaaa-bbbbbbbbbbbb',
      customerName: 'Стоян',
      deliveryType: 'courier',
      total: 4200,
      shipmentId: 'eeee',
      shipmentNumber: null,
      shipmentStatus: 'draft',
      courierPrice: null,
      labelPdfUrl: null,
      codAmount: 4200,
      trackingJson: null,
      ...econtBase,
    });
    expect(out.method).toBe('econtAddress');
  });

  it('no waybill yet → pending status, no tracking number', () => {
    const out = mapShipmentRow({
      orderId: '33333333-4444-5555-6666-777777777777',
      customerName: null,
      deliveryType: 'econt',
      total: 1000,
      shipmentId: null,
      shipmentNumber: null,
      shipmentStatus: null,
      courierPrice: null,
      labelPdfUrl: null,
      codAmount: null,
      trackingJson: null,
      ...econtBase,
    });
    expect(out.status).toBe('pending');
    expect(out.trackingNumber).toBeUndefined();
    expect(out.customerName).toBe('—');
  });

  it('maps Econt returned/refused raw statuses to returned/refused (not delivered/shipped)', () => {
    const mk = (shipmentStatus: string) => mapShipmentRow({
      orderId: '44444444-5555-6666-7777-888888888888',
      customerName: 'Иван', deliveryType: 'econt', total: 1000,
      shipmentId: 'cccc', shipmentNumber: '1051000000003', shipmentStatus,
      courierPrice: null, labelPdfUrl: null, codAmount: null, trackingJson: null,
      ...econtBase,
    }).status;
    expect(mk('Пратката е върната на подателя')).toBe('returned');
    expect(mk('Отказана от получателя')).toBe('refused');
    expect(mk('Анулирана')).toBe('refused');
  });

  it('Speedy row: surfaces carrier=speedy, trackingNumber from barcode, status=created', () => {
    const out = mapShipmentRow({
      orderId: '55555555-6666-7777-8888-999999999999',
      customerName: 'Георги',
      deliveryType: 'econt_address', // Speedy door orders share this deliveryType
      total: 3000,
      shipmentId: 'dddd',
      shipmentNumber: null,           // Econt waybill number — absent for Speedy
      shipmentStatus: 'created',
      courierPrice: 799,
      labelPdfUrl: 'https://speedy.bg/label/dddd.pdf',
      codAmount: null,
      trackingJson: null,
      carrier: 'speedy',              // shipments.carrier set by Speedy service
      orderCarrier: 'speedy',         // orders.carrier set at checkout
      trackingNumber: 'SP00000000001', // Speedy barcode stored in trackingNumber column
      carrierShipmentId: 'sp-internal-123',
    });
    expect(out.carrier).toBe('speedy');
    expect(out.trackingNumber).toBe('SP00000000001');
    expect(out.status).toBe('created');
    expect(out.shipmentId).toBe('dddd');
  });

  it('Speedy pending row (no shipment yet): carrier falls back to orderCarrier', () => {
    const out = mapShipmentRow({
      orderId: '66666666-7777-8888-9999-aaaaaaaaaaaa',
      customerName: 'Калина',
      deliveryType: 'econt_address',
      total: 2000,
      shipmentId: null,
      shipmentNumber: null,
      shipmentStatus: null,
      courierPrice: null,
      labelPdfUrl: null,
      codAmount: null,
      trackingJson: null,
      carrier: null,       // no shipment row yet
      orderCarrier: 'speedy',
      trackingNumber: null,
      carrierShipmentId: null,
    });
    expect(out.carrier).toBe('speedy');
    expect(out.status).toBe('pending');
    expect(out.trackingNumber).toBeUndefined();
  });
});

describe('mergePdfs', () => {
  async function onePager(): Promise<Buffer> {
    const doc = await PDFDocument.create();
    doc.addPage();
    return Buffer.from(await doc.save());
  }

  it('merges N single-page PDFs into one document with N pages', async () => {
    const merged = await mergePdfs([await onePager(), await onePager(), await onePager()]);
    const out = await PDFDocument.load(merged);
    expect(out.getPageCount()).toBe(3);
  });

  it('skips unreadable buffers rather than throwing', async () => {
    const merged = await mergePdfs([await onePager(), Buffer.from('not a pdf')]);
    const out = await PDFDocument.load(merged);
    expect(out.getPageCount()).toBe(1);
  });
});

describe('mapTrackingEvents', () => {
  it('maps Econt trackingEvents into {at,label,location}', () => {
    const out = mapTrackingEvents({
      trackingEvents: [
        { time: '2026-06-23T08:00:00', officeName: 'Бургас Център', destinationType: 'office' },
        { time: '2026-06-23T14:30:00', officeName: 'София Изток', destinationType: 'delivery' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0].location).toBe('Бургас Център');
    expect(typeof out[0].at).toBe('string');
    expect(out[0].label.length).toBeGreaterThan(0);
  });

  it('prefers the Bulgarian narrative (destinationDetails) over the raw enum', () => {
    const out = mapTrackingEvents({
      trackingEvents: [
        {
          time: '2026-06-23T08:00:00',
          destinationType: 'office',
          destinationDetails: 'Пратката е приета в офис Бургас',
          cityName: 'Бургас',
        },
      ],
    });
    expect(out[0].label).toBe('Пратката е приета в офис Бургас');
    expect(out[0].location).toBe('Бургас');
  });

  it('returns [] for null / shapeless payloads', () => {
    expect(mapTrackingEvents(null)).toEqual([]);
    expect(mapTrackingEvents({})).toEqual([]);
  });
});

describe('shouldNotifyShipped', () => {
  it('notifies once on shipped/delivered when not yet notified', () => {
    expect(shouldNotifyShipped('shipped', null)).toBe(true);
    expect(shouldNotifyShipped('delivered', null)).toBe(true);
  });
  it('does not notify before shipping or after already notifying', () => {
    expect(shouldNotifyShipped('created', null)).toBe(false);
    expect(shouldNotifyShipped('pending', null)).toBe(false);
    expect(shouldNotifyShipped('shipped', new Date())).toBe(false);
  });
});

describe('parseCodReconciliation', () => {
  it('reads collected + settled from ISO strings', () => {
    const out = parseCodReconciliation({ cdCollectedTime: '2026-06-23T10:00:00', cdPaidTime: '2026-06-25T09:00:00' });
    expect(out.collectedAt).toBeInstanceOf(Date);
    expect(out.settledAt).toBeInstanceOf(Date);
  });
  it('reads a unix-seconds timestamp (not interpreted as 1970)', () => {
    const out = parseCodReconciliation({ cdCollectedTime: 1782547200 }); // 2026-06-07 in seconds
    expect(out.collectedAt).toBeInstanceOf(Date);
    expect(out.collectedAt!.getUTCFullYear()).toBe(2026);
  });
  it('reads a unix-ms timestamp', () => {
    const out = parseCodReconciliation({ cdPaidTime: 1782547200000 });
    expect(out.settledAt!.getUTCFullYear()).toBe(2026);
  });
  it('returns nulls when absent or shapeless', () => {
    expect(parseCodReconciliation({})).toEqual({ collectedAt: null, settledAt: null });
    expect(parseCodReconciliation(null)).toEqual({ collectedAt: null, settledAt: null });
  });
});

describe('buildManualOrderShape', () => {
  it('office + COD → econt office order-like shape with cod payment', () => {
    const o = buildManualOrderShape({
      receiverName: 'Иван', receiverPhone: '0888', deliveryMode: 'office',
      receiverOfficeCode: '1234', weightGrams: 2000, contents: 'мед',
      codAmountStotinki: 2400, smsNotification: true, refrigerated: true, declaredValueStotinki: 5000,
    });
    expect(o.customerName).toBe('Иван');
    expect(o.deliveryType).toBe('econt');
    expect(o.econtOffice).toBe('1234');
    expect(o.paymentMethod).toBe('cod');
    expect(o.totalStotinki).toBe(2400);
    expect(o.weightKg).toBe(2);
    expect(o.smsNotification).toBe(true);
    expect(o.refrigerated).toBe(true);
    expect(o.declaredValueStotinki).toBe(5000);
  });

  it('address + no COD → econt_address shape, online payment, no cod', () => {
    const o = buildManualOrderShape({
      receiverName: 'Мария', receiverPhone: '0877', deliveryMode: 'address',
      receiverCity: 'София', receiverAddress: 'ул. Шипка 5',
    });
    expect(o.deliveryType).toBe('econt_address');
    expect(o.deliveryCity).toBe('София');
    expect(o.deliveryAddress).toBe('ул. Шипка 5');
    expect(o.paymentMethod).toBe('online');
    expect(o.totalStotinki).toBeNull();
    expect(o.weightKg).toBeUndefined();
  });

  it('passes inspectBeforePay through to the order shape', () => {
    const o = buildManualOrderShape({
      receiverName: 'Х', receiverPhone: '0', deliveryMode: 'office',
      receiverOfficeCode: '1', codAmountStotinki: 1000, inspectBeforePay: 'open',
    });
    expect(o.inspectBeforePay).toBe('open');
  });

  it('omits inspectBeforePay when off/absent', () => {
    const o = buildManualOrderShape({ receiverName: 'Х', receiverPhone: '0', deliveryMode: 'office' });
    expect(o.inspectBeforePay).toBeUndefined();
  });
});

describe('mapManualShipmentRow', () => {
  it('maps a stored manual Econt shipment to the admin shape using receiver columns', () => {
    const out = mapManualShipmentRow({
      shipmentId: 'aaaa', orderId: null,
      receiverName: 'Иван', deliveryMode: 'address',
      shipmentNumber: '1051000000009', shipmentStatus: 'created',
      courierPrice: 599, labelPdfUrl: 'https://e/x.pdf', codAmount: 2400,
      trackingJson: null,
      carrier: null, trackingNumber: null, carrierShipmentId: null,
    });
    expect(out.customerName).toBe('Иван');
    expect(out.method).toBe('econtAddress');
    expect(out.status).toBe('created');
    expect(out.trackingNumber).toBe('1051000000009');
    expect(out.codAmountStotinki).toBe(2400);
    expect(out.shipmentId).toBe('aaaa');
    expect(out.orderNumber).toBe('Ръчна');
    expect(out.manual).toBe(true);
    // Legacy Econt manual row defaults to 'econt'.
    expect(out.carrier).toBe('econt');
  });

  it('maps a Speedy manual shipment row: carrier=speedy, barcode as trackingNumber', () => {
    const out = mapManualShipmentRow({
      shipmentId: 'bbbb', orderId: null,
      receiverName: 'Мария', deliveryMode: 'address',
      shipmentNumber: null,            // econtShipmentNumber — absent for Speedy
      shipmentStatus: 'created',
      courierPrice: 799, labelPdfUrl: 'https://speedy.bg/label/bbbb.pdf', codAmount: null,
      trackingJson: null,
      carrier: 'speedy',
      trackingNumber: 'SP00000000002', // Speedy barcode
      carrierShipmentId: 'sp-456',
    });
    expect(out.carrier).toBe('speedy');
    expect(out.trackingNumber).toBe('SP00000000002');
    expect(out.status).toBe('created');
    expect(out.manual).toBe(true);
  });
});

describe('parseAddressValidation', () => {
  it('normal/processed → valid', () => {
    expect(parseAddressValidation({ validationStatus: 'normal' }).valid).toBe(true);
    expect(parseAddressValidation({ validationStatus: 'processed' }).valid).toBe(true);
  });
  it('invalid / missing → not valid', () => {
    expect(parseAddressValidation({ validationStatus: 'invalid' }).valid).toBe(false);
    expect(parseAddressValidation(null).valid).toBe(false);
  });
  it('passes the raw status through', () => {
    expect(parseAddressValidation({ validationStatus: 'normal' }).status).toBe('normal');
  });
});

describe('EcontService.validateAddress', () => {
  it('reads top-level validationStatus (sibling of address), not address.validationStatus', async () => {
    const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
    // Live Econt shape: { address: {...}, validationStatus, serviceInfo } — status is a sibling.
    (svc as unknown as { callTenant: (...a: unknown[]) => Promise<unknown> }).callTenant = jest
      .fn()
      .mockResolvedValue({ address: { city: { name: 'София' }, fullAddress: 'бул. Витоша 1' }, validationStatus: 'normal' });
    const out = await svc.validateAddress('t1', { city: 'София', address: 'бул. Витоша 1' } as never);
    expect(out).toEqual({ valid: true, status: 'normal' });
  });
});

describe('slimClientProfiles', () => {
  it('maps Econt client profiles to sender suggestions', () => {
    const out = slimClientProfiles({
      profiles: [
        { client: { name: 'Ферма Петрови', phones: ['0888111222'], clientNumber: '1234567' } },
        { client: { name: 'Втора', phones: [] } },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ name: 'Ферма Петрови', phone: '0888111222', clientNumber: '1234567' });
    expect(out[1]).toEqual({ name: 'Втора', phone: '', clientNumber: null });
  });
  it('tolerates a flat profiles array + shapeless input', () => {
    expect(slimClientProfiles(null)).toEqual([]);
    expect(slimClientProfiles({ profiles: [{ name: 'Плосък', phones: ['0700'] }] })[0]).toEqual({ name: 'Плосък', phone: '0700', clientNumber: null });
  });
});

describe('EcontService.estimateKeyFor', () => {
  const svc = new EcontService(
    {} as never,
    { get: () => '' } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const keyFor = (
    tenantId: string,
    order: Record<string, unknown>,
    weightKg: number,
    cod: number,
    sender?: Record<string, unknown>,
  ): string => (svc as any).estimateKeyFor(tenantId, order, weightKg, cod, sender);

  const order = {
    customerName: '—', customerPhone: '—',
    deliveryType: 'econt_address' as const, econtOffice: null,
    deliveryAddress: 'Варна', deliveryCity: 'Варна', totalStotinki: null,
  };

  it('caches COD and non-COD estimates under different keys', () => {
    const plainKey = keyFor('t1', order, 1, 0);
    const codKey = keyFor('t1', order, 1, 5000);
    expect(plainKey).not.toEqual(codKey);
    expect(codKey).toContain('cod');
  });

  it('non-COD key ends with :cod0', () => {
    const key = keyFor('t1', order, 1, 0);
    expect(key).toMatch(/:cod0$/);
  });

  it('COD key buckets amount to nearest 1000 stotinki', () => {
    // 5000 stotinki → bucket 5000, 5001 stotinki → bucket 6000
    const key5000 = keyFor('t1', order, 1, 5000);
    const key5001 = keyFor('t1', order, 1, 5001);
    expect(key5000).toMatch(/:cod5000$/);
    expect(key5001).toMatch(/:cod6000$/);
  });

  it('office destination uses office code not city', () => {
    const officeOrder = { ...order, deliveryType: 'econt', econtOffice: '1234' };
    const key = keyFor('t1', officeOrder, 1, 0);
    expect(key).toContain('office:1234');
    expect(key).not.toContain('city:');
  });

  it('a sender change (different origin) produces a different key — saveSenders busts tenant:{slug}, not this 8h key', () => {
    const senderA = { mode: 'office', officeCode: '111' };
    const senderB = { mode: 'office', officeCode: '222' };
    expect(keyFor('t1', order, 1, 0, senderA)).not.toEqual(keyFor('t1', order, 1, 0, senderB));
  });

  it('an address-mode sender keys on cityName', () => {
    const sender = { mode: 'address', cityName: 'Бургас' };
    expect(keyFor('t1', order, 1, 0, sender)).toContain('city:бургас');
  });
});

describe('buildCourierRequest', () => {
  const senderAddress = { sender: { name: 'Ферма', phone: '0888', mode: 'address', cityName: 'Бургас', address: 'ул. 1' } };
  it('door sender → senderAddress + attached numbers + packCount', () => {
    const body = buildCourierRequest(senderAddress as never, ['1051000000001', '1051000000002'], { timeFrom: '2026-06-25 10:00', timeTo: '2026-06-25 18:00' });
    expect(body.attachShipments).toEqual(['1051000000001', '1051000000002']);
    expect(body.shipmentPackCount).toBe(2);
    expect(body.requestTimeFrom).toBe('2026-06-25 10:00');
    expect(body.senderClient).toEqual({ name: 'Ферма', phones: ['0888'] });
    expect((body.senderAddress as any).city.name).toBe('Бургас');
  });
  it('office sender → senderOfficeCode instead of address', () => {
    const body = buildCourierRequest(
      { sender: { name: 'Ф', phone: '0', mode: 'office', officeCode: '99' } } as never,
      ['1051000000003'], {},
    );
    expect(body.senderOfficeCode).toBe('99');
    expect(body.senderAddress).toBeUndefined();
  });
});

describe('EcontService.listShipments (farmer-scoped)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);

  it('returns the farmer\'s courier orders joined with shipment drafts (not [])', async () => {
    // The farmer branch runs a single select(...).from(orders).leftJoin(shipments)
    // .where(...).orderBy(...) chain and maps each row via mapShipmentRow.
    const joined = [
      {
        orderId: '11111111-2222-3333-4444-555555555555',
        customerName: 'Иван',
        deliveryType: 'courier',
        total: 2400,
        shipmentId: 'ship-1',
        shipmentNumber: null,            // draft → no Econt waybill number yet
        shipmentStatus: 'draft',
        courierPrice: null,
        labelPdfUrl: null,
        codAmount: 2400,
        trackingJson: null,
        carrier: null,
        orderCarrier: null,
        trackingNumber: null,
        carrierShipmentId: null,
      },
    ];
    const limit = jest.fn().mockResolvedValue(joined);
    const orderBy = jest.fn().mockReturnValue({ limit });
    const where = jest.fn().mockReturnValue({ orderBy });
    const leftJoin = jest.fn().mockReturnValue({ where });
    const from = jest.fn().mockReturnValue({ leftJoin });
    const select = jest.fn().mockReturnValue({ from });
    (svc as any).db = { select };

    const out = await svc.listShipments('t1', 'farmer-1');
    expect(out.items).toHaveLength(1);
    expect(out.nextCursor).toBeNull();
    // Reuses mapShipmentRow → AdminShipment shape (draft has no waybill → pending).
    expect(out.items[0].orderId).toBe('11111111-2222-3333-4444-555555555555');
    expect(out.items[0].customerName).toBe('Иван');
    expect(out.items[0].codAmountStotinki).toBe(2400);
    expect(out.items[0].status).toBe('pending'); // draft, no number → uiShipmentStatus → pending
    expect(select).toHaveBeenCalledTimes(1); // single query, NOT the admin's two-query Promise.all
  });
});

describe('EcontService.createLabel (finalize courier draft)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);

  it('finalizes a courier draft → ADDRESS waybill, stamps farmerId + carrier, updates orders.carrier', async () => {
    // Farmer's own creds/config (per-farmer defaultPackage weight) come via loadStored.
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      tenant: { id: 't1', settings: {} },
      econt: {
        sender: { name: 'Ферма', phone: '0888', mode: 'office', officeCode: '1234' },
        defaultPackage: { weightKg: 2.5 },
      },
    });
    // A courier order: address delivery, COD, owning farmer set on the order.
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      order: {
        tenantId: 't1', farmerId: 'farmer-1',
        customerName: 'Стоян', customerPhone: '0833',
        deliveryType: 'courier', econtOffice: null,
        deliveryCity: 'Пловдив', deliveryAddress: 'бул. България 12',
        totalStotinki: 4200, paymentMethod: 'cod', paidAt: null,
      },
      items: [{ name: 'Домати', qty: 2 }],
    });
    // resolveHandling is now a pure import; loadStored returns settings:{} above,
    // so the real fn yields the same all-off result (no stub needed).
    const callTenant = jest.fn().mockResolvedValue({ label: { shipmentNumber: '1051000000009', pdfURL: 'x.pdf', totalPrice: 6.9 } });
    (svc as any).callTenant = callTenant;

    // db.insert(...).values(...).onConflictDoUpdate(...).returning()
    const returning = jest.fn().mockResolvedValue([{ orderId: 'order-1', farmerId: 'farmer-1', carrier: 'econt', status: 'created' }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    // db.update(orders).set(...).where(...)
    const updWhere = jest.fn().mockResolvedValue(undefined);
    const updSet = jest.fn().mockReturnValue({ where: updWhere });
    const update = jest.fn().mockReturnValue({ set: updSet });
    // db.select(...).from(shipments).where(...).limit(1) — the pre-read for a possible
    // consolidation-master override; no existing draft row here → [] → unchanged codAmountFor path.
    const selLimit = jest.fn().mockResolvedValue([]);
    const selWhere = jest.fn().mockReturnValue({ limit: selLimit });
    const selFrom = jest.fn().mockReturnValue({ where: selWhere });
    const select = jest.fn().mockReturnValue({ from: selFrom });
    (svc as any).db = { insert, update, select };

    const row = await svc.createLabel('t1', 'order-1', 'farmer-1');

    // (a) ADDRESS label — door, not an office code.
    // callTenant(tenantId, path, { label, mode }, ...) → body is arg index 2.
    const label = callTenant.mock.calls[0][2].label;
    expect(label.receiverAddress).toEqual({ city: { name: 'Пловдив' }, other: 'бул. България 12' });
    expect(label.receiverOfficeCode).toBeUndefined();
    expect(label.weight).toBe(2.5); // farmer defaultPackage.weightKg
    // (b) shipments upsert stamps farmerId + carrier in BOTH insert values and update set.
    const insertVals = values.mock.calls[0][0];
    expect(insertVals.farmerId).toBe('farmer-1');
    expect(insertVals.carrier).toBe('econt');
    expect(insertVals.status).toBe('created');
    const updateSet = onConflictDoUpdate.mock.calls[0][0].set;
    expect(updateSet.farmerId).toBe('farmer-1');
    expect(updateSet.carrier).toBe('econt');
    expect(updateSet.status).toBe('created');
    // (c) orders.carrier persisted = 'econt'.
    expect(update).toHaveBeenCalled();
    expect(updSet.mock.calls[0][0]).toEqual({ carrier: 'econt' });
    expect(row.carrier).toBe('econt');
  });

  it('consolidation MASTER draft present → waybill collects the group-sum COD, not the order total', async () => {
    // Farmer's own creds/config (per-farmer defaultPackage weight) come via loadStored.
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      tenant: { id: 't1', settings: {} },
      econt: {
        sender: { name: 'Ферма', phone: '0888', mode: 'office', officeCode: '1234' },
        defaultPackage: { weightKg: 2.5 },
      },
    });
    // The collector's own order total (500) is the smaller, distinguishable value —
    // if the override wired in c7d134e didn't take effect, the assertion below on
    // 1800 would fail against this 500.
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      order: {
        tenantId: 't1', farmerId: 'farmer-1',
        customerName: 'Стоян', customerPhone: '0833',
        deliveryType: 'courier', econtOffice: null,
        deliveryCity: 'Пловдив', deliveryAddress: 'бул. България 12',
        totalStotinki: 500, paymentMethod: 'cod', paidAt: null,
      },
      items: [{ name: 'Домати', qty: 2 }],
    });
    const callTenant = jest.fn().mockResolvedValue({ label: { shipmentNumber: '1051000000010', pdfURL: 'x.pdf', totalPrice: 6.9 } });
    (svc as any).callTenant = callTenant;

    // db.insert(...).values(...).onConflictDoUpdate(...).returning()
    const returning = jest.fn().mockResolvedValue([{ orderId: 'order-1', farmerId: 'farmer-1', carrier: 'econt', status: 'created' }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    // db.update(...) serves BOTH the pre-call labeling CLAIM on the master
    // (.set().where().returning() → 1 row = claimed) and the post-persist orders
    // carrier update (.set().where() awaited). A promise carrying `.returning`
    // satisfies both shapes.
    const updWhere = jest.fn(() => {
      const p: any = Promise.resolve([{ id: 'ship-1' }]);
      p.returning = async () => [{ id: 'ship-1' }];
      return p;
    });
    const updSet = jest.fn().mockReturnValue({ where: updWhere });
    const update = jest.fn().mockReturnValue({ set: updSet });
    // db.select(...).from(shipments).where(...).limit(1) — this time a real MASTER row:
    // consolidationGroupId === id, holding the whole group's COD (1800).
    const selLimit = jest.fn().mockResolvedValue([{ id: 'ship-1', consolidationGroupId: 'ship-1', codAmountStotinki: 1800 }]);
    const selWhere = jest.fn().mockReturnValue({ limit: selLimit });
    const selFrom = jest.fn().mockReturnValue({ where: selWhere });
    const select = jest.fn().mockReturnValue({ from: selFrom });
    (svc as any).db = { insert, update, select };

    await svc.createLabel('t1', 'order-1', 'farmer-1');

    // The WAYBILL SENT TO ECONT must instruct collection of the group sum (1800 →
    // 18.00 EUR), NOT the collector's own order total (500 → 5.00). This is the
    // amount the courier actually collects at the door; asserting only the persisted
    // column (below) let the bug ship — the DB said 1800 while Econt was told 500.
    // callTenant(tenantId, path, { label, mode }, ...) → the payload is arg [2].
    const sentLabel = callTenant.mock.calls[0][2].label as {
      services: { cdAmount?: number; cdType?: string };
    };
    expect(sentLabel.services.cdAmount).toBe(18);

    // The persisted COD must also be the master's group sum (1800), NOT the order's
    // own total (500) — proves the live createLabel path actually applies the override.
    const insertVals = values.mock.calls[0][0];
    expect(insertVals.codAmountStotinki).toBe(1800);
    const updateSet = onConflictDoUpdate.mock.calls[0][0].set;
    expect(updateSet.codAmountStotinki).toBe(1800);
  });

  // Double-COD race guard: a consolidation master's waybill collects the WHOLE group's
  // COD, but its econtShipmentNumber is persisted only AFTER the carrier call. createLabel
  // must CLAIM the master (status='labeling') BEFORE the call so a concurrent unconsolidate
  // can't free the children mid-flight — and must ROLL the claim back if the call fails.
  it('consolidation master: claims status=labeling before the carrier call, resets it on failure', async () => {
    const seq: string[] = [];
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      tenant: { id: 't1', settings: {} },
      econt: { sender: { name: 'Ферма', phone: '0888', mode: 'office', officeCode: '1234' }, defaultPackage: { weightKg: 2 } },
    });
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      order: {
        tenantId: 't1', farmerId: 'farmer-1', customerName: 'Стоян', customerPhone: '0833',
        deliveryType: 'courier', econtOffice: null, deliveryCity: 'Пловдив',
        deliveryAddress: 'бул. България 12', totalStotinki: 500, paymentMethod: 'cod', paidAt: null,
      },
      items: [{ name: 'Домати', qty: 1 }],
    });
    const callTenant = jest.fn(() => {
      seq.push('call');
      return Promise.reject(new Error('econt down'));
    });
    (svc as any).callTenant = callTenant;

    const updWhere = jest.fn(() => {
      const p: any = Promise.resolve([{ id: 'ship-1' }]);
      p.returning = async () => [{ id: 'ship-1' }]; // claim CAS matches 1 row (succeeds)
      return p;
    });
    const updSet = jest.fn((v: any) => {
      if (v.status) seq.push(`set:${v.status}`);
      return { where: updWhere };
    });
    const update = jest.fn().mockReturnValue({ set: updSet });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate: jest.fn().mockReturnValue({ returning: async () => [{}] }) });
    const insert = jest.fn().mockReturnValue({ values });
    const selLimit = jest.fn().mockResolvedValue([{ id: 'ship-1', consolidationGroupId: 'ship-1', codAmountStotinki: 1800 }]);
    const select = jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: selLimit }) }) });
    (svc as any).db = { insert, update, select };

    await expect(svc.createLabel('t1', 'order-1', 'farmer-1')).rejects.toThrow('econt down');
    // claim written BEFORE the carrier call…
    expect(seq).toContain('set:labeling');
    expect(seq.indexOf('set:labeling')).toBeLessThan(seq.indexOf('call'));
    // …and rolled back to 'draft' AFTER the call failed (so the master is unconsolidatable again).
    expect(seq).toContain('set:draft');
    expect(seq.indexOf('set:draft')).toBeGreaterThan(seq.indexOf('call'));
  });

  it('rejects finalizing another farmer\'s courier order (authz) before any carrier call', async () => {
    (svc as any).loadStored = jest.fn().mockResolvedValue({ tenant: { id: 't1', settings: {} }, econt: {} });
    // Order owned by farmer-1; caller is farmer-2.
    (svc as any).orderForShipment = jest.fn().mockResolvedValue({
      order: { tenantId: 't1', farmerId: 'farmer-1', deliveryType: 'courier' },
      items: [],
    });
    const callTenant = jest.fn();
    (svc as any).callTenant = callTenant;
    await expect(svc.createLabel('t1', 'order-1', 'farmer-2')).rejects.toThrow('друга ферма');
    expect(callTenant).not.toHaveBeenCalled(); // no waybill created
  });

  // Shared db mock for the credential-resolution tests below (insert→upsert, orders update,
  // consolidation pre-read returns no master).
  function wireDb(svc: EcontService) {
    const returning = jest.fn().mockResolvedValue([{ orderId: 'order-1', farmerId: 'farmer-1', carrier: 'econt', status: 'created' }]);
    const onConflictDoUpdate = jest.fn().mockReturnValue({ returning });
    const values = jest.fn().mockReturnValue({ onConflictDoUpdate });
    const insert = jest.fn().mockReturnValue({ values });
    const updWhere = jest.fn().mockResolvedValue(undefined);
    const update = jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updWhere }) });
    const selLimit = jest.fn().mockResolvedValue([]);
    const select = jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn().mockReturnValue({ limit: selLimit }) }) });
    (svc as any).db = { insert, update, select };
  }

  const perFarmerOrder = {
    order: {
      tenantId: 't1', farmerId: 'farmer-1',
      customerName: 'Стоян', customerPhone: '0833',
      deliveryType: 'courier', econtOffice: null,
      deliveryCity: 'Пловдив', deliveryAddress: 'бул. България 12',
      totalStotinki: 4200, paymentMethod: 'cod', paidAt: null,
    },
    items: [{ name: 'Домати', qty: 2 }],
  };

  it('admin finalize (no farmerId arg): a per-farmer order ships on THAT farmer\'s Econt account when connected', async () => {
    // Farmer-as-seller money path: the наложен платеж must settle to the farmer's own
    // Econt account, so the operator-triggered finalize resolves creds to the order's
    // farmer (not the tenant) when that farmer has connected Econt.
    const settings = { delivery: { farmers: { 'farmer-1': { econt: { configured: true } } } } };
    const loadStored = jest.fn()
      // probe (tenant-level) — sees farmer-1 is configured
      .mockResolvedValueOnce({ tenant: { id: 't1', settings }, econt: {} })
      // creds load with the order's farmerId → farmer's own sender/package
      .mockResolvedValueOnce({
        tenant: { id: 't1', settings },
        econt: { sender: { name: 'Ферма', phone: '0888', mode: 'office', officeCode: '1234' }, defaultPackage: { weightKg: 2.5 } },
      });
    (svc as any).loadStored = loadStored;
    (svc as any).orderForShipment = jest.fn().mockResolvedValue(perFarmerOrder);
    const callTenant = jest.fn().mockResolvedValue({ label: { shipmentNumber: '1051000000011', pdfURL: 'x.pdf', totalPrice: 6.9 } });
    (svc as any).callTenant = callTenant;
    wireDb(svc);

    await svc.createLabel('t1', 'order-1'); // NO farmerId arg = operator/admin path

    expect(loadStored.mock.calls[0][2]).toBeUndefined();   // probe read is tenant-level
    expect(loadStored.mock.calls[1][2]).toBe('farmer-1');  // creds resolved to the order's farmer
    expect(callTenant.mock.calls[0][5]).toBe('farmer-1');  // API call authenticates as the farmer
  });

  it('admin finalize: a per-farmer order whose farmer has NOT connected Econt falls back to the tenant account', async () => {
    // Graceful fallback — an unonboarded farmer must not block the operator; behavior is
    // exactly as before (tenant account) until the farmer connects their own Econt.
    const settings = { delivery: { farmers: {} } };
    const loadStored = jest.fn()
      .mockResolvedValueOnce({ tenant: { id: 't1', settings }, econt: {} }) // probe: farmer not configured
      .mockResolvedValueOnce({
        tenant: { id: 't1', settings },
        econt: { sender: { name: 'Ферма', phone: '0888', mode: 'office', officeCode: '1234' }, defaultPackage: { weightKg: 2.5 } },
      });
    (svc as any).loadStored = loadStored;
    (svc as any).orderForShipment = jest.fn().mockResolvedValue(perFarmerOrder);
    const callTenant = jest.fn().mockResolvedValue({ label: { shipmentNumber: '1051000000012', pdfURL: 'x.pdf', totalPrice: 6.9 } });
    (svc as any).callTenant = callTenant;
    wireDb(svc);

    await svc.createLabel('t1', 'order-1'); // no farmerId arg

    expect(loadStored.mock.calls[1][2]).toBeUndefined(); // creds stay tenant-level
    expect(callTenant.mock.calls[0][5]).toBeUndefined();
  });
});

describe('EcontService.codReconciliation (farmer-scoped)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);

  it('filters shipments by farmerId instead of returning []', async () => {
    const rows = [
      { orderId: 'order-1', expected: 2400, collectedAt: null, settledAt: null },
    ];
    const where = jest.fn().mockResolvedValue(rows);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    (svc as any).db = { select };

    const out = await svc.codReconciliation('t1', 'farmer-1');
    expect(out).toEqual([
      { orderId: 'order-1', expectedStotinki: 2400, collectedAt: null, settledAt: null },
    ]);
    expect(select).toHaveBeenCalledTimes(1);
  });
});

describe('EcontService farmer-ownership scoping (cross-farmer IDOR)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);

  /** Build a db whose select().from().where().limit() resolves to `rows`. Records the where()
   *  call so a test can assert the farmer scope reached the query. */
  function selectDb(rows: unknown[]) {
    const where = jest.fn();
    const limit = jest.fn().mockResolvedValue(rows);
    where.mockReturnValue({ limit });
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    return { db: { select } as any, where, select };
  }

  describe('voidShipment', () => {
    it('cross-farmer id → NotFound, NO carrier call, NO delete', async () => {
      // farmer-2 asks to void a parcel owned by farmer-1: the scoped query finds nothing.
      const { db } = selectDb([]);
      const del = jest.fn();
      db.delete = del;
      (svc as any).db = db;
      const callTenant = jest.fn();
      (svc as any).callTenant = callTenant;

      await expect(svc.voidShipment('t1', 'ship-1', 'farmer-2')).rejects.toThrow('Пратката не е намерена');
      expect(callTenant).not.toHaveBeenCalled(); // no Econt deleteLabels
      expect(del).not.toHaveBeenCalled();        // no row deleted
    });

    it('owning farmer → deletes the label + row', async () => {
      const { db } = selectDb([{ id: 'ship-1', econtShipmentNumber: '1051000000001' }]);
      const delWhere = jest.fn().mockResolvedValue(undefined);
      db.delete = jest.fn().mockReturnValue({ where: delWhere });
      (svc as any).db = db;
      const callTenant = jest.fn().mockResolvedValue({});
      (svc as any).callTenant = callTenant;

      const out = await svc.voidShipment('t1', 'ship-1', 'farmer-1');
      expect(out).toEqual({ id: 'ship-1' });
      expect(callTenant).toHaveBeenCalledTimes(1); // deleteLabels for the waybill
      expect(db.delete).toHaveBeenCalledTimes(1);
    });

    it('admin (no farmerId) → tenant-wide delete still works', async () => {
      const { db } = selectDb([{ id: 'ship-1', econtShipmentNumber: '1051000000001' }]);
      const delWhere = jest.fn().mockResolvedValue(undefined);
      db.delete = jest.fn().mockReturnValue({ where: delWhere });
      (svc as any).db = db;
      (svc as any).callTenant = jest.fn().mockResolvedValue({});

      const out = await svc.voidShipment('t1', 'ship-1');
      expect(out).toEqual({ id: 'ship-1' });
      expect(db.delete).toHaveBeenCalledTimes(1);
    });
  });

  describe('getLabelPdf', () => {
    it('cross-farmer id → NotFound, NO PDF fetch', async () => {
      const { db } = selectDb([]);
      (svc as any).db = db;
      const fetchLabelPdf = jest.fn();
      (svc as any).fetchLabelPdf = fetchLabelPdf;
      (svc as any).resolveCreds = jest.fn();

      await expect(svc.getLabelPdf('t1', 'ship-1', 'farmer-2')).rejects.toThrow('Пратката не е намерена');
      expect(fetchLabelPdf).not.toHaveBeenCalled();
    });

    it('owning farmer → fetches the PDF', async () => {
      const { db } = selectDb([{ url: 'https://ee.econt.com/x.pdf' }]);
      (svc as any).db = db;
      (svc as any).resolveCreds = jest.fn().mockResolvedValue({ username: 'u', password: 'p' });
      const fetchLabelPdf = jest.fn().mockResolvedValue(Buffer.from('PDF'));
      (svc as any).fetchLabelPdf = fetchLabelPdf;

      const out = await svc.getLabelPdf('t1', 'ship-1', 'farmer-1');
      expect(out.toString()).toBe('PDF');
      expect(fetchLabelPdf).toHaveBeenCalledTimes(1);
    });
  });

  describe('refreshStatus', () => {
    it('cross-farmer id → NotFound, NO carrier call', async () => {
      const { db } = selectDb([]);
      (svc as any).db = db;
      const refreshStatusForRow = jest.fn();
      (svc as any).refreshStatusForRow = refreshStatusForRow;

      await expect(svc.refreshStatus('t1', 'ship-1', 'farmer-2')).rejects.toThrow('Пратката не е намерена');
      expect(refreshStatusForRow).not.toHaveBeenCalled();
    });
  });

  describe('requestCourier', () => {
    it('only the farmer\'s own shipments are eligible (cross-farmer ids drop out)', async () => {
      // The scoped select returns ONLY farmer-1's shipment even though two ids were requested.
      const where = jest.fn().mockResolvedValue([{ id: 'ship-1', number: '1051000000001' }]);
      const from = jest.fn().mockReturnValue({ where });
      const select = jest.fn().mockReturnValue({ from });
      const updWhere = jest.fn().mockResolvedValue(undefined);
      const updSet = jest.fn().mockReturnValue({ where: updWhere });
      const update = jest.fn().mockReturnValue({ set: updSet });
      (svc as any).db = { select, update };
      (svc as any).loadStored = jest.fn().mockResolvedValue({ econt: { sender: { name: 'Ф', phone: '0', mode: 'office', officeCode: '1' } } });
      (svc as any).callTenant = jest.fn().mockResolvedValue({ courierRequestID: 'CR1', status: 'process' });

      const out = await svc.requestCourier(
        't1',
        { shipmentIds: ['ship-1', 'ship-2-other-farmer'], timeFrom: '2026-06-25 10:00', timeTo: '2026-06-25 18:00' } as never,
        'farmer-1',
      );
      // Only ship-1 had a waybill and matched the farmer scope → 1 attached, 1 skipped.
      expect(out.attached).toBe(1);
      expect(out.skipped).toBe(1);
    });
  });
});

describe('EcontService.maybeSeedSender (unit)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  const seed = (econt: unknown, farmName: string, contact: unknown, profiles: unknown) =>
    (svc as unknown as {
      maybeSeedSender: (e: any, n: string, c: any, p: any) => Record<string, unknown>;
    }).maybeSeedSender(econt, farmName, contact, profiles);

  it('seeds sender when empty, from the Econt profile', () => {
    const out = seed({ username: 'u' }, 'Ферма', { phone: '0700' },
      [{ name: 'Профил', phone: '0888', clientNumber: null }]);
    expect(out.sender).toEqual({ name: 'Профил', phone: '0888', mode: 'office' });
  });

  it('does NOT overwrite an existing sender', () => {
    const existing = { name: 'Ръчно', phone: '0999', mode: 'office', officeCode: '1' };
    const out = seed({ username: 'u', sender: existing }, 'Ферма', { phone: '0700' },
      [{ name: 'Профил', phone: '0888', clientNumber: null }]);
    expect(out.sender).toEqual(existing);
  });
});

describe('EcontService.clearCredsBlob (unit)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  const clear = (econt: unknown) =>
    (svc as unknown as { clearCredsBlob: (e: any) => Record<string, unknown> }).clearCredsBlob(econt);

  it('clears username/passwordEnc/configured but keeps sender', () => {
    const out = clear({ username: 'u', passwordEnc: 'enc', configured: true, env: 'demo',
      sender: { name: 'Ферма', mode: 'office' } });
    expect(out.configured).toBe(false);
    expect(out.username).toBeUndefined();
    expect(out.passwordEnc).toBeUndefined();
    expect(out.sender).toEqual({ name: 'Ферма', mode: 'office' });
  });
});

describe('EcontService.buildSenderBlob (unit)', () => {
  const svc = new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  const build = (econt: unknown, senders: unknown, activeId: string) =>
    (svc as unknown as {
      buildSenderBlob: (e: any, s: any, a: string) => Record<string, unknown>;
    }).buildSenderBlob(econt, senders, activeId);

  it('mirrors the active point into sender + keeps creds', () => {
    const out = build(
      { username: 'u', passwordEnc: 'enc', configured: true },
      [{ id: 'a', label: 'Основна', name: 'Х', mode: 'office', officeCode: '1' },
       { id: 'b', label: 'Склад', name: 'Y', mode: 'office', officeCode: '2' }],
      'b',
    );
    expect(out.username).toBe('u');
    expect(out.passwordEnc).toBe('enc');
    expect(out.activeSenderId).toBe('b');
    expect(out.sender).toEqual({ name: 'Y', mode: 'office', officeCode: '2' });
  });
});

/** Best-effort text rendering of a drizzle SQL AST (the object `and()`/`sql\`\`` build).
 *  Not a real SQL renderer — just enough to assert a guard clause's column/literal text
 *  is present, without hitting the circular PgColumn->PgTable refs that break JSON.stringify. */
function renderSqlAst(x: unknown, depth = 0): string {
  if (depth > 10 || x == null) return String(x);
  if (typeof x === 'string') return x;
  if (Array.isArray(x)) return x.map((c) => renderSqlAst(c, depth + 1)).join(' ');
  const obj = x as Record<string, unknown>;
  if (Array.isArray(obj.queryChunks)) return renderSqlAst(obj.queryChunks, depth + 1);
  if (typeof obj.name === 'string') return `col:${obj.name}`; // PgColumn
  if ('value' in obj) return renderSqlAst(obj.value, depth + 1);
  return '';
}

describe('syncOrderCodOutcome (econt)', () => {
  /** db whose update(orders).set(...).where(...).returning(...) resolves to one
   *  written row (the no-clobber guard matched) by default. Callers read
   *  `set.mock.calls[0][0]` (the payload passed to .set()) after awaiting the call.
   *  `cache.del` is a spy so the payments-cache-bust wiring can be asserted too. */
  function makeSvcWithDbSpy(returningResult: unknown[] = [{ id: 'o1', tenantId: 't1' }]) {
    const del = jest.fn().mockResolvedValue(undefined);
    const svc = new EcontService({} as never, { get: () => '' } as never, { del } as never, {} as never, {} as never);
    const returning = jest.fn().mockResolvedValue(returningResult);
    const where = jest.fn((..._args: unknown[]) => ({ returning }));
    const set = jest.fn((_payload: Record<string, unknown>) => ({ where }));
    const update = jest.fn(() => ({ set }));
    (svc as any).db = { update };
    return { svc, update, set, where, returning, del };
  }

  it('sets received when COD collected', async () => {
    const { svc, set } = makeSvcWithDbSpy();
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'доставена' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(set.mock.calls[0][0]).toMatchObject({ codOutcome: 'received', codOutcomeSource: 'courier' });
  });

  it('sets refused on a returned status', async () => {
    const { svc, set } = makeSvcWithDbSpy();
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: null, status: 'върната пратка' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(set.mock.calls[0][0]).toMatchObject({ codOutcome: 'refused', codOutcomeSource: 'courier' });
  });

  it('does nothing for a non-COD shipment', async () => {
    const { svc, set, update } = makeSvcWithDbSpy();
    await (svc as any).syncOrderCodOutcome({ orderId: 'o1', tenantId: 't1', codAmountStotinki: null } as any);
    expect(set).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('includes a WHERE cod_outcome IS NULL guard on the update (no-clobber)', async () => {
    const { svc, where } = makeSvcWithDbSpy();
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'доставена' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(where).toHaveBeenCalledTimes(1);
    // The guard is a drizzle SQL AST (`and(eq(...), sql\`...\`)`), not JSON-serializable
    // (circular PgColumn refs) or meaningfully stringifiable via toString(). Walk its
    // queryChunks/column-name/value shape so a future refactor can't silently drop the guard.
    const cond = where.mock.calls[0][0];
    expect(renderSqlAst(cond).toLowerCase()).toContain('cod_outcome');
    expect(renderSqlAst(cond).toLowerCase()).toContain('is null');
  });

  it('does nothing when orderId is missing (standalone shipment)', async () => {
    const { svc, update } = makeSvcWithDbSpy();
    await (svc as any).syncOrderCodOutcome({ orderId: null, tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date() } as any);
    expect(update).not.toHaveBeenCalled();
  });

  it('busts the payments cache when the no-clobber guard actually wrote a row', async () => {
    const { svc, del } = makeSvcWithDbSpy([{ id: 'o1', tenantId: 't1' }]);
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'доставена' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(del).toHaveBeenCalledWith('payments:totals:t1', 'payments:list:t1:all', 'payments:list:t1:cod');
  });

  it('does not bust the payments cache when the guard matched no row (already had an outcome)', async () => {
    const { svc, del } = makeSvcWithDbSpy([]);
    const shipment = { orderId: 'o1', tenantId: 't1', codAmountStotinki: 1000, codCollectedAt: new Date(), status: 'доставена' } as any;
    await (svc as any).syncOrderCodOutcome(shipment);
    expect(del).not.toHaveBeenCalled();
  });
});

describe('EcontService.applyShipmentStatus (trackingJson no-clobber on the narrowed projection)', () => {
  /** `refreshActiveShipments` now SELECTs a narrow column projection (drops the heavy
   *  `trackingJson` jsonb) before calling this, so `row.trackingJson` is never available
   *  here. This db spy captures the `.set(...)` payload so a test can assert whether
   *  `trackingJson` was included, without touching the real `orders`/codRisk side effects
   *  (those are stubbed out — covered separately by the syncOrderCodOutcome/cod-risk specs). */
  function makeApplyStatusSvc(updatedRow: Record<string, unknown>) {
    const returning = jest.fn().mockResolvedValue([updatedRow]);
    const where = jest.fn((..._args: unknown[]) => ({ returning }));
    const set = jest.fn((_payload: Record<string, unknown>) => ({ where }));
    const update = jest.fn(() => ({ set }));
    const svc = new EcontService(
      {} as never,
      { get: () => '' } as never,
      {} as never,
      { sendShipped: jest.fn().mockResolvedValue(undefined) } as never,
      { recordReturnIfApplicable: jest.fn().mockResolvedValue(undefined) } as never,
    );
    (svc as any).db = { update };
    // Best-effort side effect on the same `db` — stub it so this test stays scoped to the
    // trackingJson question instead of also exercising the orders-table update chain.
    (svc as any).syncOrderCodOutcome = jest.fn().mockResolvedValue(undefined);
    return { svc, update, set, where, returning };
  }

  const baseRow = {
    id: 's1',
    tenantId: 't1',
    orderId: null as string | null,
    econtShipmentNumber: '1051000000001',
    status: 'pending',
    customerNotifiedAt: null as Date | null,
    codCollectedAt: null as Date | null,
    codSettledAt: null as Date | null,
  };

  it('st=null (failed/empty Econt lookup) → omits trackingJson from the update payload entirely', async () => {
    const { svc, set } = makeApplyStatusSvc({ ...baseRow, status: 'pending' });
    await (svc as any).applyShipmentStatus(baseRow, null);
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][0]).not.toHaveProperty('trackingJson');
  });

  it('st present → writes trackingJson to the new status payload', async () => {
    const st = { shipmentNumber: '1051000000001', shortDeliveryStatus: 'доставена' };
    const { svc, set } = makeApplyStatusSvc({ ...baseRow, status: 'доставена' });
    await (svc as any).applyShipmentStatus(baseRow, st);
    expect(set.mock.calls[0][0]).toHaveProperty('trackingJson', st);
  });

  it('st present → still applies the status + COD fallbacks from the projected row', async () => {
    const st = { shipmentNumber: '1051000000001', shortDeliveryStatus: 'доставена' };
    const row = { ...baseRow, codCollectedAt: new Date('2026-01-01') };
    const { svc, set } = makeApplyStatusSvc({ ...row, status: 'доставена' });
    await (svc as any).applyShipmentStatus(row, st);
    expect(set.mock.calls[0][0]).toMatchObject({
      status: 'доставена',
      codCollectedAt: row.codCollectedAt, // no cod.collectedAt from `st` → falls back to row's
    });
  });
});

describe('EcontService.refreshActiveShipments', () => {
  function makeSvc() {
    return new EcontService({} as never, { get: () => '' } as never, {} as never, {} as never, {} as never);
  }

  it('projects only the columns applyShipmentStatus needs — no trackingJson', async () => {
    const svc = makeSvc();
    const where = jest.fn().mockResolvedValue([]);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    (svc as any).db = { select };

    await svc.refreshActiveShipments();

    expect(select).toHaveBeenCalledTimes(1);
    const projection = select.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(projection).sort()).toEqual(
      ['codCollectedAt', 'codSettledAt', 'customerNotifiedAt', 'econtShipmentNumber', 'id', 'orderId', 'status', 'tenantId'].sort(),
    );
    expect(projection).not.toHaveProperty('trackingJson');
  });

  it('drops delivered/returned/refused + tenant-less rows; only the eligible row reaches applyShipmentStatus', async () => {
    const svc = makeSvc();
    const rows = [
      { id: 's-shipped', tenantId: 't1', orderId: null, econtShipmentNumber: '1', status: 'в транзит', customerNotifiedAt: null, codCollectedAt: null, codSettledAt: null },
      { id: 's-delivered', tenantId: 't1', orderId: null, econtShipmentNumber: '2', status: 'доставена', customerNotifiedAt: null, codCollectedAt: null, codSettledAt: null },
      { id: 's-returned', tenantId: 't1', orderId: null, econtShipmentNumber: '3', status: 'върната пратка', customerNotifiedAt: null, codCollectedAt: null, codSettledAt: null },
      { id: 's-refused', tenantId: 't1', orderId: null, econtShipmentNumber: '4', status: 'отказана пратка', customerNotifiedAt: null, codCollectedAt: null, codSettledAt: null },
      { id: 's-no-tenant', tenantId: null, orderId: null, econtShipmentNumber: '5', status: 'в транзит', customerNotifiedAt: null, codCollectedAt: null, codSettledAt: null },
    ];
    const where = jest.fn().mockResolvedValue(rows);
    const from = jest.fn().mockReturnValue({ where });
    const select = jest.fn().mockReturnValue({ from });
    (svc as any).db = { select };
    (svc as any).callTenant = jest.fn().mockResolvedValue({ shipmentStatuses: [] });
    const applyShipmentStatus = jest.fn().mockResolvedValue({});
    (svc as any).applyShipmentStatus = applyShipmentStatus;

    const out = await svc.refreshActiveShipments();

    expect(applyShipmentStatus).toHaveBeenCalledTimes(1);
    expect(applyShipmentStatus.mock.calls[0][0].id).toBe('s-shipped');
    expect(out.refreshed).toBe(1);
  });
});

describe('EcontService.disconnect / saveCredentials — estimate cache bust', () => {
  function makeSvc(): EcontService {
    const config = { get: (k: string, d: unknown) => (k === 'ENCRYPTION_KEY' ? 'test-enc-key' : d) } as any;
    return new EcontService({} as never, config, {} as never, {} as never, {} as never);
  }

  it('disconnect busts the tenant-scoped estimate prefix', async () => {
    const svc = makeSvc();
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      tenant: { slug: 'ferma-x' },
      econt: { username: 'u', passwordEnc: 'enc', configured: true },
    });
    const updWhere = jest.fn().mockResolvedValue(undefined);
    (svc as any).db = { update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: updWhere }) }) };
    const del = jest.fn();
    const delByPrefix = jest.fn();
    (svc as any).cache = { del, delByPrefix };

    await svc.disconnect('tenant-1');

    expect(delByPrefix).toHaveBeenCalledWith('econt:estimate:tenant-1:');
  });

  it('saveCredentials busts the tenant-scoped estimate prefix on a successful reconnect', async () => {
    const svc = makeSvc();
    (svc as any).loadStored = jest.fn().mockResolvedValue({
      tenant: { slug: 'ferma-x', isDemo: false, name: 'Ferma', settings: {} },
      econt: {},
    });
    (svc as any).call = jest.fn().mockResolvedValue({});
    (svc as any).db = { update: jest.fn().mockReturnValue({ set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }) }) };
    const del = jest.fn();
    const delByPrefix = jest.fn();
    (svc as any).cache = { del, delByPrefix };

    await svc.saveCredentials('tenant-1', { username: 'u', password: 'p' });

    expect(delByPrefix).toHaveBeenCalledWith('econt:estimate:tenant-1:');
  });
});
