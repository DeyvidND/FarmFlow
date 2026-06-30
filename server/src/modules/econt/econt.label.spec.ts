import {
  buildLabel,
  bucketWeight,
  resolveHandling,
  parseDimensions,
  econtInspectLabelFields,
  type EcontStored,
} from './econt.label';

const senderOffice: EcontStored = {
  sender: { name: 'Ферма Петрови', phone: '0888123456', mode: 'office', officeCode: '1234' },
  defaultPackage: { weightKg: 2 },
};

const baseOrder = {
  customerName: 'Иван Иванов',
  customerPhone: '0899000111',
  econtOffice: '5678',
  totalStotinki: 2500,
  paymentMethod: 'online' as const,
  paidAt: new Date(),
};

describe('buildLabel', () => {
  it('builds an office→office shipment with no services for a paid online order', () => {
    const label = buildLabel(senderOffice, { ...baseOrder, deliveryType: 'econt' }, []);
    expect(label.senderOfficeCode).toBe('1234');
    expect(label.receiverOfficeCode).toBe('5678');
    expect(label.senderClient).toEqual({ name: 'Ферма Петрови', phones: ['0888123456'] });
    expect(label.senderAgent).toEqual({ name: 'Ферма Петрови', phones: ['0888123456'] });
    expect(label.weight).toBe(2);
    // Paid online → no COD, no services key at all.
    expect(label.services).toBeUndefined();
  });

  it('uses the address branch for econt_address and courier deliveries', () => {
    const addr = { ...baseOrder, deliveryType: 'econt_address', deliveryCity: 'Бургас', deliveryAddress: 'ул. Лом 3' };
    const label = buildLabel(senderOffice, addr, []);
    expect(label.receiverAddress).toEqual({ city: { name: 'Бургас' }, other: 'ул. Лом 3' });
    expect(label.receiverOfficeCode).toBeUndefined();
  });

  it('attaches a sender address when the sender is in address mode', () => {
    const econt: EcontStored = {
      sender: { name: 'Ф', phone: '1', mode: 'address', cityName: 'София', address: 'бул. 1' },
    };
    const label = buildLabel(econt, { ...baseOrder, deliveryType: 'econt' }, []);
    expect(label.senderAddress).toEqual({ city: { name: 'София' }, other: 'бул. 1' });
    expect(label.senderOfficeCode).toBeUndefined();
  });

  it('adds COD (cdAmount in EUR) only for an unpaid cod order, and routes the fee', () => {
    const econt: EcontStored = { ...senderOffice, cod: { feePayer: 'customer' } };
    const label = buildLabel(
      econt,
      { ...baseOrder, deliveryType: 'econt', paymentMethod: 'cod', paidAt: null },
      [],
    );
    const services = label.services as Record<string, unknown>;
    expect(services.cdAmount).toBe(25); // 2500 stotinki → 25.00 EUR
    expect(services.cdType).toBe('get');
    expect(services.cdCurrency).toBe('EUR');
    expect(label.paymentReceiverMethod).toBe('cash'); // customer pays the fee
  });

  it('never charges COD again on an already-paid order', () => {
    const label = buildLabel(
      senderOffice,
      { ...baseOrder, deliveryType: 'econt', paymentMethod: 'cod', paidAt: new Date() },
      [],
    );
    expect(label.services).toBeUndefined();
  });

  it('emits inspect-before-pay fields only on a COD parcel', () => {
    const codOpen = buildLabel(
      senderOffice,
      { ...baseOrder, deliveryType: 'econt', paymentMethod: 'cod', paidAt: null, inspectBeforePay: 'open' },
      [],
    );
    expect(codOpen.payAfterAccept).toBe(true);
    // Same flag on a paid order → ignored (no COD gate).
    const paid = buildLabel(senderOffice, { ...baseOrder, deliveryType: 'econt', inspectBeforePay: 'open' }, []);
    expect(paid.payAfterAccept).toBeUndefined();
  });

  it('derives package contents from items when no default is set', () => {
    const econt: EcontStored = { sender: { name: 'Ф', phone: '1' } };
    const label = buildLabel(econt, { ...baseOrder, deliveryType: 'econt' }, [
      { name: 'Мед', qty: 2 },
      { name: 'Орехи', qty: 1 },
    ]);
    expect(label.shipmentDescription).toBe('Мед x2, Орехи x1');
  });

  it('includes parsed dimensions only when all three parse', () => {
    const ok = buildLabel({ ...senderOffice, defaultPackage: { weightKg: 1, dimensions: '20x10x5' } }, { ...baseOrder, deliveryType: 'econt' }, []);
    expect(ok.shipmentDimensionsL).toBe(20);
    expect(ok.shipmentDimensionsH).toBe(5);
    const bad = buildLabel({ ...senderOffice, defaultPackage: { weightKg: 1, dimensions: '20x10' } }, { ...baseOrder, deliveryType: 'econt' }, []);
    expect(bad.shipmentDimensionsL).toBeUndefined();
  });
});

describe('bucketWeight', () => {
  it('rounds up to the 0.5kg bucket', () => {
    expect(bucketWeight(1.1)).toBe(1.5);
    expect(bucketWeight(1.5)).toBe(1.5);
    expect(bucketWeight(1.6)).toBe(2);
  });
});

describe('resolveHandling', () => {
  it('reads refrigerated + inspect mode off settings.delivery.handling', () => {
    expect(resolveHandling({ delivery: { handling: { refrigerated: true, inspectBeforePay: 'test' } } })).toEqual({
      refrigerated: true,
      inspectBeforePay: 'test',
    });
  });
  it('defaults everything off for missing/odd shapes', () => {
    expect(resolveHandling(null)).toEqual({ refrigerated: false, inspectBeforePay: 'off' });
    expect(resolveHandling({ delivery: { handling: { inspectBeforePay: 'bogus' } } })).toEqual({
      refrigerated: false,
      inspectBeforePay: 'off',
    });
  });
});

describe('parseDimensions', () => {
  it('parses three positive numbers from free text', () => {
    expect(parseDimensions('20 x 10 x 5')).toEqual({ l: 20, w: 10, h: 5 });
  });
  it('returns null for non-strings or fewer than three numbers', () => {
    expect(parseDimensions(123)).toBeNull();
    expect(parseDimensions('20x10')).toBeNull();
  });
});

describe('econtInspectLabelFields', () => {
  it('maps modes to the top-level label flags', () => {
    expect(econtInspectLabelFields('open')).toEqual({ payAfterAccept: true });
    expect(econtInspectLabelFields('test')).toEqual({ payAfterTest: true });
    expect(econtInspectLabelFields('off')).toBeNull();
    expect(econtInspectLabelFields(null)).toBeNull();
  });
});
