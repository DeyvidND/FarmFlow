import { describe, it, expect } from 'vitest';
import { sortReadiness, READINESS_MISSING_LABEL } from './farmer-readiness';
import type { FarmerReadiness, FarmerReadinessMissing } from './types';

const row = (over: Partial<FarmerReadiness> = {}): FarmerReadiness => ({
  farmerId: 'f1',
  name: 'Фермер',
  email: null,
  ready: true,
  missing: [],
  ...over,
});

describe('sortReadiness', () => {
  it('puts incomplete farmers first, even when that breaks alphabetical order', () => {
    const rows = [
      row({ farmerId: 'a', name: 'Ана', ready: true, missing: [] }),
      row({ farmerId: 'b', name: 'Борис', ready: false, missing: ['signature'] }),
    ];
    const sorted = sortReadiness(rows);
    expect(sorted.map((r) => r.farmerId)).toEqual(['b', 'a']); // not-ready Борис before ready Ана
  });

  it('sorts alphabetically (bg) among farmers with the same readiness', () => {
    const rows = [
      row({ farmerId: 'z', name: 'Явор', ready: false, missing: ['address'] }),
      row({ farmerId: 'a', name: 'Ана', ready: false, missing: ['signature'] }),
    ];
    const sorted = sortReadiness(rows);
    expect(sorted.map((r) => r.farmerId)).toEqual(['a', 'z']);
  });

  it('does not mutate the input array', () => {
    const rows = [row({ farmerId: 'a', ready: true }), row({ farmerId: 'b', ready: false })];
    const copy = [...rows];
    sortReadiness(rows);
    expect(rows).toEqual(copy);
  });
});

describe('READINESS_MISSING_LABEL', () => {
  it('has a non-empty Bulgarian label for every FarmerReadinessMissing code', () => {
    const codes: FarmerReadinessMissing[] = ['kind', 'name', 'identifier', 'address', 'signature'];
    for (const c of codes) expect(READINESS_MISSING_LABEL[c]?.length).toBeGreaterThan(0);
  });
});
