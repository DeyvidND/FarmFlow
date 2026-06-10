import { EcontService } from './econt.service';

// buildLabel is a pure mapping (no I/O), so we can construct the service with
// stub deps and call it directly. These assert the payload matches the Econt
// ShippingLabel model: top-level shipmentDimensions*/paymentSender|ReceiverMethod,
// COD under `services`.
describe('EcontService.buildLabel', () => {
  const svc = new EcontService(
    {} as never,
    { get: () => '' } as never,
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
});
