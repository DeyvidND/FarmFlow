import {
  parseTrackStatus, trackingUrl, buildShipmentRequest, parsePayouts,
  slimSites, slimOffices, slimStreets, slimContractClients, toEur,
  buildOrderShipmentInput, buildCalculateRequest, parseCalculatePrice,
} from './speedy.helpers';

describe('toEur', () => {
  it('converts stotinki to a 2dp EUR number', () => {
    expect(toEur(2400)).toBe(24);
    expect(toEur(2399)).toBe(23.99);
    expect(toEur(0)).toBe(0);
  });
});

describe('parseTrackStatus', () => {
  it('returns pending when there is no barcode yet', () => {
    expect(parseTrackStatus([], false)).toBe('pending');
  });
  it('maps delivered / returned / refused / in-transit from the latest operation', () => {
    expect(parseTrackStatus([{ description: 'Пратката е доставена' }], true)).toBe('delivered');
    expect(parseTrackStatus([{ description: 'Върната на подателя' }], true)).toBe('returned');
    expect(parseTrackStatus([{ description: 'Отказана от получателя' }], true)).toBe('refused');
    expect(parseTrackStatus([{ description: 'Товарителницата е в транзит' }], true)).toBe('shipped');
    expect(parseTrackStatus([{ description: 'returned to sender' }], true)).toBe('returned');
    expect(parseTrackStatus([{ description: 'refused by recipient' }], true)).toBe('refused');
  });
  it('uses the LAST operation (newest) to decide', () => {
    const ops = [{ description: 'в транзит' }, { description: 'доставена' }];
    expect(parseTrackStatus(ops, true)).toBe('delivered');
  });
  it('falls back to created when a barcode exists but no operation matches', () => {
    expect(parseTrackStatus([{ description: 'Приета в офис' }], true)).toBe('created');
    expect(parseTrackStatus([], true)).toBe('created');
  });
  it('does NOT read a "товарителница приета" op as shipped (товар-stem collision)', () => {
    // "товарителница" (waybill) contains the stem "товар" but is not movement.
    expect(parseTrackStatus([{ description: 'Товарителницата е приета' }], true)).toBe('created');
    expect(parseTrackStatus([{ description: 'Товарителница създадена' }], true)).toBe('created');
    // a genuinely loaded parcel still maps to shipped via "натоварен"
    expect(parseTrackStatus([{ description: 'Пратката е натоварена' }], true)).toBe('shipped');
  });
  it('the returned/refused tokens are recognized by cod-risk isReturnedStatus', () => {
    expect('returned'.includes('return')).toBe(true);
    expect('refused'.includes('refus')).toBe(true);
  });
});

describe('trackingUrl', () => {
  it('builds the Speedy public tracking link and strips spaces', () => {
    expect(trackingUrl('123 456')).toContain('123456');
    expect(trackingUrl('123456')).toContain('speedy.bg');
  });
});

describe('buildShipmentRequest', () => {
  const cfg = {
    sender: { contactName: 'Ферма Иванови', phone: '0888112233', mode: 'office', officeId: 70 },
    defaultPackage: { parcelsCount: 1, weightKg: 1, contents: 'Хранителни продукти' },
  };

  it('builds an office-delivery body with recipient.pickupOfficeId and NO address', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван Петров', receiverPhone: '0899445566',
      deliveryMode: 'office', officeId: 123, serviceId: 505,
    } as any) as any;
    expect(body.recipient.clientName).toBe('Иван Петров');
    expect(body.recipient.phone1.number).toBe('0899445566');
    expect(body.recipient.privatePerson).toBe(true);
    // Office delivery: pickupOfficeId at recipient level, NO recipient.address
    // (a present address is validated as a door address and rejected live).
    expect(body.recipient.pickupOfficeId).toBe(123);
    expect(body.recipient.address).toBeUndefined();
    expect(body.service.serviceId).toBe(505);
    expect(body.content.parcelsCount).toBe(1);
    // content.package is REQUIRED on create (Speedy 605 without it).
    expect(body.content.package).toBe('BOX');
    expect(body.service.additionalServices).toBeUndefined();
  });

  it('builds a door-address body with siteId/streetId/streetNo (no pickupOfficeId)', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван', receiverPhone: '0899445566',
      deliveryMode: 'address', siteId: 68134, streetId: 3109, streetNo: '1A', serviceId: 505,
    } as any) as any;
    expect(body.recipient.address.siteId).toBe(68134);
    expect(body.recipient.address.streetId).toBe(3109);
    expect(body.recipient.address.streetNo).toBe('1A');
    expect(body.recipient.address.officeId).toBeUndefined();
    expect(body.recipient.pickupOfficeId).toBeUndefined();
    expect(body.content.package).toBe('BOX');
  });

  it('adds COD in EUR when a COD amount is given', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван', receiverPhone: '0899445566',
      deliveryMode: 'office', officeId: 123, serviceId: 505, codAmountStotinki: 2400,
    } as any) as any;
    expect(body.service.additionalServices.cod.amount).toBe(24);
    expect(body.service.additionalServices.cod.processingType).toBe('CASH');
    expect(body.service.additionalServices.cod.currencyCode).toBe('EUR');
  });

  it('converts weightGrams to kg and honours parcelsCount/contents overrides', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван', receiverPhone: '0899445566',
      deliveryMode: 'office', officeId: 123, serviceId: 505,
      weightGrams: 1500, parcelsCount: 2, contents: 'Мед',
    } as any) as any;
    expect(body.content.totalWeight).toBe(1.5);
    expect(body.content.parcelsCount).toBe(2);
    expect(body.content.contents).toBe('Мед');
  });
});

describe('buildCalculateRequest', () => {
  const cfg = { defaultPackage: { weightKg: 1, parcelsCount: 1 } } as any;

  it('uses the /calculate shape: serviceIds[] + recipient.addressLocation (NOT address)', () => {
    const body = buildCalculateRequest(cfg, { siteId: 68134, serviceId: 505, weightGrams: 1500 }) as any;
    expect(body.service.serviceIds).toEqual([505]);
    expect(body.service.serviceId).toBeUndefined();
    expect(body.recipient.addressLocation.siteId).toBe(68134);
    expect(body.recipient.address).toBeUndefined();
    expect(body.content.totalWeight).toBe(1.5);
    expect(body.payment.courierServicePayer).toBe('RECIPIENT');
  });

  it('adds COD in EUR onto service.additionalServices when requested', () => {
    const body = buildCalculateRequest(cfg, { siteId: 68134, serviceId: 505, codAmountStotinki: 2000 }) as any;
    expect(body.service.additionalServices.cod.amount).toBe(20);
    expect(body.service.additionalServices.cod.currencyCode).toBe('EUR');
  });
});

describe('parseCalculatePrice', () => {
  it('reads calculations[0].price.total (live shape)', () => {
    expect(parseCalculatePrice({ calculations: [{ serviceId: 505, price: { total: 5.72, amount: 4.77, currency: 'EUR' } }] })).toBe(5.72);
  });
  it('falls back to price.amount and returns null when absent', () => {
    expect(parseCalculatePrice({ calculations: [{ price: { amount: 3.32 } }] })).toBe(3.32);
    expect(parseCalculatePrice({ calculations: [] })).toBeNull();
    expect(parseCalculatePrice({ error: { message: 'x' } })).toBeNull();
    expect(parseCalculatePrice(null)).toBeNull();
  });
});

describe('parsePayouts', () => {
  it('maps a Speedy payout report into reconciliation rows (defensive shape)', () => {
    const rows = parsePayouts({ payouts: [
      { shipmentBarcode: '123', amount: 24, paidDate: '2026-06-20T00:00:00+03:00' },
    ] });
    expect(rows).toHaveLength(1);
    expect(rows[0].barcode).toBe('123');
    expect(rows[0].amountStotinki).toBe(2400);
    expect(rows[0].settledAt).toBe('2026-06-20T00:00:00+03:00');
  });
  it('handles an array root and missing fields', () => {
    expect(parsePayouts([{ amount: 10 }])[0].amountStotinki).toBe(1000);
    expect(parsePayouts(null)).toEqual([]);
  });
});

describe('slim mappers', () => {
  it('slimSites reads id/name/postCode defensively', () => {
    const s = slimSites({ sites: [{ id: 68134, name: 'София', postCode: '1000' }] });
    expect(s[0]).toEqual({ id: 68134, name: 'София', postCode: '1000' });
    expect(slimSites(null)).toEqual([]);
  });
  it('slimOffices reads id/name/address', () => {
    const o = slimOffices({ offices: [{ id: 70, name: 'Офис Изток', address: { fullAddress: 'бул. Витоша 1' } }] });
    expect(o[0]).toEqual({ id: 70, name: 'Офис Изток', address: 'бул. Витоша 1' });
  });
  it('slimOffices nulls a structured address with no fullAddress (never returns an object)', () => {
    const o = slimOffices({ offices: [{ id: 70, name: 'Офис', address: { siteName: 'София' } }] });
    expect(o[0].address).toBeNull();
    const flat = slimOffices({ offices: [{ id: 71, name: 'Офис 2', address: 'ул. Г. С. Раковски 2' }] });
    expect(flat[0].address).toBe('ул. Г. С. Раковски 2');
  });
  it('slimStreets reads id/name', () => {
    const s = slimStreets({ streets: [{ id: 3109, name: 'Витоша' }] });
    expect(s[0]).toEqual({ id: 3109, name: 'Витоша' });
  });
  it('slimContractClients maps to sender suggestions', () => {
    const c = slimContractClients({ clients: [{ clientName: 'Ферма', phones: [{ number: '0888' }], id: 9 }] });
    expect(c[0]).toEqual({ name: 'Ферма', phone: '0888', clientNumber: '9' });
  });
});

describe('buildOrderShipmentInput', () => {
  const cfg = {
    configured: true,
    defaultServiceId: 505,
    defaultPackage: { weightKg: 1.5, contents: 'Хранителни продукти' },
  } as any;

  it('maps a door order to a Speedy shipment input with COD when unpaid cod', () => {
    const input = buildOrderShipmentInput(
      cfg,
      {
        customerName: 'Иван',
        customerPhone: '0888',
        deliveryAddress: 'ул. Шипка 5',
        paymentMethod: 'cod',
        paidAt: null,
        totalStotinki: 5000,
      } as any,
      100, // resolved siteId
    );
    expect(input.deliveryMode).toBe('address');
    expect(input.siteId).toBe(100);
    expect(input.serviceId).toBe(505);
    expect(input.weightGrams).toBe(1500);
    expect(input.codAmountStotinki).toBe(5000);
    expect(input.receiverName).toBe('Иван');
    expect(input.receiverPhone).toBe('0888');
  });

  it('puts the free-typed street (+ block hint) into addressNote so Speedy accepts a streetless door order', () => {
    const input = buildOrderShipmentInput(
      cfg,
      {
        customerName: 'Иван',
        customerPhone: '0888',
        deliveryAddress: 'ул. Самоковско шосе 1',
        deliveryNote: 'бл. 5, ап. 3',
        paymentMethod: 'online',
        paidAt: null,
        totalStotinki: 5000,
      } as any,
      100,
    );
    expect(input.addressNote).toBe('ул. Самоковско шосе 1, бл. 5, ап. 3');
    // and it must surface in the actual Speedy request body under recipient.address.addressNote
    const body = buildShipmentRequest(cfg, input) as any;
    expect(body.recipient.address.addressNote).toBe('ул. Самоковско шосе 1, бл. 5, ап. 3');
    expect(body.recipient.address.siteId).toBe(100);
  });

  it('threads returnReceipt + declaredValue overrides into the request additionalServices', () => {
    const input = buildOrderShipmentInput(
      cfg,
      { customerName: 'Иван', customerPhone: '0888', deliveryAddress: 'ул. Шипка 5', paymentMethod: 'online', paidAt: null, totalStotinki: 0 } as any,
      100,
      { returnReceipt: true, declaredValueStotinki: 5000 },
    );
    expect(input.returnReceipt).toBe(true);
    const body = buildShipmentRequest(cfg, input) as any;
    expect(body.service.additionalServices.returnReceipt).toBe(true);
    expect(body.service.additionalServices.declaredValue).toEqual({ amount: 50 });
  });

  it('does NOT collect COD on a paid order or online payment', () => {
    // paid COD order → no COD collected
    const paidCod = buildOrderShipmentInput(
      cfg,
      {
        customerName: 'Мария',
        customerPhone: '0899',
        deliveryAddress: 'ул. Витоша 1',
        paymentMethod: 'cod',
        paidAt: new Date('2026-06-01'),
        totalStotinki: 3000,
      } as any,
      200,
    );
    expect(paidCod.codAmountStotinki).toBeUndefined();

    // online payment → no COD regardless of paidAt
    const online = buildOrderShipmentInput(
      cfg,
      {
        customerName: 'Петър',
        customerPhone: '0877',
        deliveryAddress: 'ул. Раковски 5',
        paymentMethod: 'online',
        paidAt: null,
        totalStotinki: 2000,
      } as any,
      300,
    );
    expect(online.codAmountStotinki).toBeUndefined();
  });
});
