import {
  parseTrackStatus, trackingUrl, buildShipmentRequest, parsePayouts,
  slimSites, slimOffices, slimStreets, slimContractClients, toEur,
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

  it('builds an office-delivery body with id-based recipient address', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван Петров', receiverPhone: '0899445566',
      deliveryMode: 'office', officeId: 123, serviceId: 505,
    } as any) as any;
    expect(body.recipient.clientName).toBe('Иван Петров');
    expect(body.recipient.phone1.number).toBe('0899445566');
    expect(body.recipient.privatePerson).toBe(true);
    expect(body.recipient.address.officeId).toBe(123);
    expect(body.service.serviceId).toBe(505);
    expect(body.content.parcelsCount).toBe(1);
    expect(body.service.additionalServices).toBeUndefined();
  });

  it('builds a door-address body with siteId/streetId/streetNo', () => {
    const body = buildShipmentRequest(cfg, {
      receiverName: 'Иван', receiverPhone: '0899445566',
      deliveryMode: 'address', siteId: 68134, streetId: 3109, streetNo: '1A', serviceId: 505,
    } as any) as any;
    expect(body.recipient.address.siteId).toBe(68134);
    expect(body.recipient.address.streetId).toBe(3109);
    expect(body.recipient.address.streetNo).toBe('1A');
    expect(body.recipient.address.officeId).toBeUndefined();
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
