import { describe, it, expect } from 'vitest';
import { slotColor } from './slots';

describe('slotColor', () => {
  it('is green (free) while booked < capacity', () => {
    expect(slotColor(0, 1).bg).toContain('green');
    expect(slotColor(1, 2).bg).toContain('green');
  });
  it('is gray (full) when booked >= capacity', () => {
    expect(slotColor(1, 1).bg).not.toContain('green');
    expect(slotColor(2, 2).bg).not.toContain('green');
  });
});
