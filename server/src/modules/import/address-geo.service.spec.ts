import { AddressGeoService } from './address-geo.service';
import type { MapsService } from '../../common/maps/maps.service';
import type { ImportAiService } from './import.ai';

const POINT = { lat: 42.69, lng: 23.32 };

function make(geocode: jest.Mock, repair: jest.Mock = jest.fn().mockResolvedValue([]), enabled = true) {
  const maps = { geocode, enabled } as unknown as MapsService;
  const ai = { repairAddresses: repair } as unknown as ImportAiService;
  return new AddressGeoService(maps, ai);
}

describe('AddressGeoService', () => {
  it('skips the check (all ok / empty) when Google maps is disabled (no key)', async () => {
    const geocode = jest.fn();
    const svc = make(geocode, jest.fn(), false);
    expect(await svc.checkOne('каквото и да е', 'София')).toEqual({ status: 'ok' });
    expect(await svc.checkMany([{ rowIndex: 1, address: 'x', city: 'София' }])).toEqual(new Map());
    expect(geocode).not.toHaveBeenCalled();
  });

  it('checkOne → ok when geocode finds a point', async () => {
    const svc = make(jest.fn().mockResolvedValue(POINT));
    expect(await svc.checkOne('ул. Витоша 1', 'София')).toEqual({ status: 'ok' });
  });

  it('checkOne → fixed when AI suggestion geocodes', async () => {
    const geocode = jest.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(POINT);
    const repair = jest.fn().mockResolvedValue([{ index: 0, suggestion: 'бул. Витоша 1, София' }]);
    const svc = make(geocode, repair);
    expect(await svc.checkOne('Витоша бл до аптеката', 'София')).toEqual({ status: 'fixed', suggestion: 'бул. Витоша 1, София' });
  });

  it('checkOne → unresolved when neither original nor suggestion geocodes', async () => {
    const svc = make(jest.fn().mockResolvedValue(null), jest.fn().mockResolvedValue([{ index: 0, suggestion: 'xxx' }]));
    expect(await svc.checkOne('zzz', 'София')).toEqual({ status: 'unresolved' });
  });

  it('checkMany → one AI call for all broken rows', async () => {
    const geocode = jest.fn()
      .mockResolvedValueOnce(POINT)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(POINT);
    const repair = jest.fn().mockResolvedValue([{ index: 2, suggestion: 'fixed addr' }]);
    const svc = make(geocode, repair);
    const out = await svc.checkMany([
      { rowIndex: 1, address: 'good', city: 'София' },
      { rowIndex: 2, address: 'bad', city: 'София' },
    ]);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(out.get(1)).toEqual({ status: 'ok' });
    expect(out.get(2)).toEqual({ status: 'fixed', suggestion: 'fixed addr' });
  });
});
