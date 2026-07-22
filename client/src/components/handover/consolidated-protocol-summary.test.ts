import { describe, expect, it } from 'vitest';
import { legLabel } from './consolidated-protocol-client';

describe('legLabel', () => {
  it('labels the day-scope row', () => {
    expect(legLabel({ scope: 'day', legIndex: null } as any)).toBe('Целия ден');
  });
  it('labels a leg row 1-based', () => {
    expect(legLabel({ scope: 'leg', legIndex: 0 } as any)).toBe('Лег 1');
    expect(legLabel({ scope: 'leg', legIndex: 2 } as any)).toBe('Лег 3');
  });
});
