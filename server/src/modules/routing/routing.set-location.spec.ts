import { BadRequestException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { RoutingService } from './routing.service';

// ---------------------------------------------------------------------------
// Stubs: a db that returns pre-loaded rows on successive select() calls and
// records the update() payload, plus a maps service with a scripted geocode.
// ---------------------------------------------------------------------------

function makeDb(selectResults: any[][]) {
  const results = [...selectResults];
  const updates: any[] = [];
  const db = {
    select: () => {
      const result = results.length ? results.shift()! : [];
      const chain: any = {
        from: () => chain,
        where: () => chain,
        limit: () => Promise.resolve(result),
        then: (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject),
      };
      return chain;
    },
    update: () => ({
      set: (payload: any) => {
        updates.push(payload);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
    __updates: updates,
  } as any;
  return db;
}

const ORDER = { id: 'o1', address: 'ул. Шипка 5, Варна', city: 'Варна', deliveryType: 'address' };
const TENANT = { farmLat: '43.1729', farmLng: '27.8456' };

function makeService(db: any, geocode: jest.Mock) {
  const maps = { geocode } as any;
  return new RoutingService(db, maps);
}

describe('RoutingService.setStopLocation', () => {
  it('throws NotFound when the order is not in this tenant (no IDOR)', async () => {
    const svc = makeService(makeDb([[]]), jest.fn());
    await expect(svc.setStopLocation('t1', 'o1', { address: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects an order that is not address-delivery', async () => {
    const db = makeDb([[{ ...ORDER, deliveryType: 'econtOffice' }]]);
    const svc = makeService(db, jest.fn());
    await expect(svc.setStopLocation('t1', 'o1', { address: 'x' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('geocodes a corrected address (biased to the farm) and saves the pin', async () => {
    const geocode = jest.fn().mockResolvedValue({ lat: 43.2, lng: 27.9 });
    const db = makeDb([[ORDER], [TENANT]]);
    const svc = makeService(db, geocode);

    const out = await svc.setStopLocation('t1', 'o1', { address: 'ул. Шипка 15, Варна' });

    expect(geocode).toHaveBeenCalledWith(
      'ул. Шипка 15, Варна',
      { lat: 43.1729, lng: 27.8456 },
      { locality: 'Варна' },
    );
    expect(out).toEqual({ lat: 43.2, lng: 27.9, address: 'ул. Шипка 15, Варна' });
    expect(db.__updates[0]).toEqual({
      deliveryLat: '43.2',
      deliveryLng: '27.9',
      deliveryAddress: 'ул. Шипка 15, Варна',
    });
  });

  it('throws 422 when the address still cannot be geocoded', async () => {
    const geocode = jest.fn().mockResolvedValue(null);
    const db = makeDb([[ORDER], [TENANT]]);
    const svc = makeService(db, geocode);
    await expect(
      svc.setStopLocation('t1', 'o1', { address: 'непознато' }),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(db.__updates).toHaveLength(0);
  });

  it('saves a manual pin (lat+lng) without calling geocode', async () => {
    const geocode = jest.fn();
    const db = makeDb([[ORDER]]); // no tenant lookup needed — geocode skipped
    const svc = makeService(db, geocode);

    const out = await svc.setStopLocation('t1', 'o1', { lat: 43.21, lng: 27.91 });

    expect(geocode).not.toHaveBeenCalled();
    expect(out).toEqual({ lat: 43.21, lng: 27.91, address: ORDER.address });
    expect(db.__updates[0]).toEqual({
      deliveryLat: '43.21',
      deliveryLng: '27.91',
      deliveryAddress: ORDER.address,
    });
  });
});
