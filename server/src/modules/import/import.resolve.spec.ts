import { pickBest, matchByName } from './import.resolve';

describe('pickBest', () => {
  it('returns the exact (case-insensitive) name match when present', () => {
    const list = [{ id: 1, name: 'Бургас' }, { id: 2, name: 'Бургаски' }];
    expect(pickBest(list, 'бургас', (x) => x.name)).toEqual({ chosen: list[0], ambiguous: false, candidates: [] });
  });

  it('flags ambiguity when several prefix-match and none is exact', () => {
    const list = [{ id: 1, name: 'Софийка' }, { id: 2, name: 'Софиево' }];
    const out = pickBest(list, 'софи', (x) => x.name);
    expect(out.chosen).toBeNull();
    expect(out.ambiguous).toBe(true);
    expect(out.candidates).toHaveLength(2);
  });

  it('returns null/empty when there is no match', () => {
    expect(pickBest([{ id: 1, name: 'Варна' }], 'пловдив', (x: any) => x.name)).toEqual({
      chosen: null, ambiguous: false, candidates: [],
    });
  });

  it('auto-picks a single prefix match', () => {
    const out = pickBest([{ id: 9, name: 'Пловдив' }], 'плов', (x) => x.name);
    expect(out.chosen).toEqual({ id: 9, name: 'Пловдив' });
  });
});

describe('matchByName', () => {
  it('finds an office by case-insensitive substring', () => {
    const offices = [{ code: 'A1', name: 'Изгрев' }, { code: 'B2', name: 'Център' }];
    expect(matchByName(offices, 'изгрев', (o) => o.name)?.code).toBe('A1');
  });
  it('returns null when none match', () => {
    expect(matchByName([{ code: 'A1', name: 'Изгрев' }], 'няма', (o) => o.name)).toBeNull();
  });
});
