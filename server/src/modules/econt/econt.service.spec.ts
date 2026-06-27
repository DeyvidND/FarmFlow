import { PDFDocument } from 'pdf-lib';
import { EcontService, mapShipmentRow, mapTrackingEvents, mergePdfs, parseCodReconciliation, shouldNotifyShipped, buildManualOrderShape, mapManualShipmentRow, parseAddressValidation, slimClientProfiles, buildCourierRequest } from './econt.service';

// buildLabel is a pure mapping (no I/O), so we can construct the service with
// stub deps and call it directly. These assert the payload matches the Econt
// ShippingLabel model: top-level shipmentDimensions*/paymentSender|ReceiverMethod,
// COD under `services`.
describe('EcontService.buildLabel', () => {
  const svc = new EcontService(
    {} as never,
    { get: () => '' } as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const build = (econt: Record<string, unknown>, order: Record<string, unknown>): Record<string, any> =>
    (svc as unknown as { buildLabel: (e: unknown, o: unknown, i: unknown) => Record<string, any> }).buildLabel(
      econt,
      order,
      [{ name: 'Домати', qty: 2 }],
    );

  const sender = { name: 'Ферма Петрови', phone: '0888111222', mode: 'office', officeCode: '1234' };

  it('office shipment: COD with customer paying → receiver pays cash + dimensions sent', () => {
    const label = build(
      {
        sender,
        defaultPackage: { weightKg: 2, contents: 'зеленчуци', dimensions: '20x15x10' },
        cod: { enabled: true, feePayer: 'customer' },
      },
      { customerName: 'Иван', customerPhone: '0899', deliveryType: 'econt', econtOffice: '5678', totalStotinki: 2400, paymentMethod: 'cod' },
    );

    expect(label.receiverOfficeCode).toBe('5678');
    expect(label.senderOfficeCode).toBe('1234');
    expect(label.weight).toBe(2);
    // COD lives under services; amount is EUR (stotinki / 100).
    expect(label.services).toEqual({ cdAmount: 24, cdType: 'get', cdCurrency: 'EUR' });
    // customer pays → receiver method, top-level.
    expect(label.paymentReceiverMethod).toBe('cash');
    expect(label.paymentSenderMethod).toBeUndefined();
    // dimensions parsed to top-level numeric fields.
    expect(label.shipmentDimensionsL).toBe(20);
    expect(label.shipmentDimensionsW).toBe(15);
    expect(label.shipmentDimensionsH).toBe(10);
  });

  it('door shipment: COD with farm paying → sender pays cash; no dims when unparseable', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1, dimensions: 'няма' }, cod: { enabled: true, feePayer: 'farm' } },
      {
        customerName: 'Мария',
        customerPhone: '0877',
        deliveryType: 'econt_address',
        deliveryCity: 'София',
        deliveryAddress: 'ул. Шипка 5',
        totalStotinki: 5000,
        paymentMethod: 'cod',
      },
    );

    expect(label.receiverAddress).toEqual({ city: { name: 'София' }, other: 'ул. Шипка 5' });
    expect(label.paymentSenderMethod).toBe('cash');
    expect(label.paymentReceiverMethod).toBeUndefined();
    expect(label.shipmentDimensionsL).toBeUndefined();
  });

  it('online order → no COD even when the farm has a COD/feePayer config', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 }, cod: { enabled: true, feePayer: 'customer' } },
      {
        customerName: 'Петър', customerPhone: '0866', deliveryType: 'econt',
        econtOffice: '9999', totalStotinki: 3000, paymentMethod: 'online',
      },
    );

    expect(label.services).toBeUndefined();
    expect(label.paymentReceiverMethod).toBeUndefined();
    expect(label.paymentSenderMethod).toBeUndefined();
  });

  it('COD order already paid online → no second collection at the door', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 }, cod: { enabled: true, feePayer: 'customer' } },
      {
        customerName: 'Анна', customerPhone: '0855', deliveryType: 'econt', econtOffice: '7777',
        totalStotinki: 4000, paymentMethod: 'cod', paidAt: new Date(),
      },
    );

    expect(label.services).toBeUndefined();
  });

  it('parses comma/space/slash separated dimensions', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1, dimensions: '30 / 20, 12' } },
      { customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1', totalStotinki: 1000 },
    );
    expect([label.shipmentDimensionsL, label.shipmentDimensionsW, label.shipmentDimensionsH]).toEqual([30, 20, 12]);
  });

  it('emits SMS + refrigerated + declared-value services when set', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 } },
      {
        customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1',
        totalStotinki: 1000, paymentMethod: 'cod',
        smsNotification: true, refrigerated: true, declaredValueStotinki: 5000,
      },
    );
    expect(label.services).toMatchObject({
      cdAmount: 10, cdType: 'get', cdCurrency: 'EUR',
      smsNotification: true,
      refrigeratedPack: 1,
      declaredValueAmount: 50,
      declaredValueCurrency: 'EUR',
    });
  });

  it('no flags + no COD → no services object at all', () => {
    const label = build(
      { sender, defaultPackage: { weightKg: 1 } },
      { customerName: 'Х', customerPhone: '0', deliveryType: 'econt', econtOffice: '1', totalStotinki: 1000, paymentMethod: 'online' },
    );
    expect(label.services).toBeUndefined();
  });
});

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

describe('mapShipmentRow', () => {
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
    });
    expect(out.orderNumber).toBe('11111111');
    expect(out.method).toBe('econtOffice');
    expect(out.status).toBe('created');
    expect(out.trackingNumber).toBe('1051000000001');
    expect(out.priceStotinki).toBe(599);
    expect(out.codAmountStotinki).toBe(2400);
    expect(out.labelPdfUrl).toBe('https://ee.econt.com/x.pdf');
    expect(out.history).toEqual([]);
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
    });
    expect(out.method).toBe('econtAddress');
    // courierPrice null → falls back to order total.
    expect(out.priceStotinki).toBe(5000);
    expect(out.labelPdfUrl).toBeUndefined();
    expect(out.codAmountStotinki).toBeUndefined();
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
    }).status;
    expect(mk('Пратката е върната на подателя')).toBe('returned');
    expect(mk('Отказана от получателя')).toBe('refused');
    expect(mk('Анулирана')).toBe('refused');
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
});

describe('mapManualShipmentRow', () => {
  it('maps a stored manual shipment to the admin shape using receiver columns', () => {
    const out = mapManualShipmentRow({
      shipmentId: 'aaaa', orderId: null,
      receiverName: 'Иван', deliveryMode: 'address',
      shipmentNumber: '1051000000009', shipmentStatus: 'created',
      courierPrice: 599, labelPdfUrl: 'https://e/x.pdf', codAmount: 2400,
      trackingJson: null,
    });
    expect(out.customerName).toBe('Иван');
    expect(out.method).toBe('econtAddress');
    expect(out.status).toBe('created');
    expect(out.trackingNumber).toBe('1051000000009');
    expect(out.codAmountStotinki).toBe(2400);
    expect(out.shipmentId).toBe('aaaa');
    expect(out.orderNumber).toBe('Ръчна');
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
  const keyFor = (tenantId: string, order: Record<string, unknown>, weightKg: number, cod: number): string =>
    (svc as any).estimateKeyFor(tenantId, order, weightKg, cod);

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
