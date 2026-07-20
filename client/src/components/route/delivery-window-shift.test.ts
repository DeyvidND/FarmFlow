import { describe, expect, it } from 'vitest';
import { isHHMM, windowShiftDeltaMin } from './delivery-window-shift';

describe('isHHMM', () => {
  it('accepts valid 24h times', () => {
    expect(isHHMM('00:00')).toBe(true);
    expect(isHHMM('09:05')).toBe(true);
    expect(isHHMM('23:59')).toBe(true);
  });
  it('rejects malformed / out-of-range values', () => {
    expect(isHHMM('24:00')).toBe(false);
    expect(isHHMM('9:5')).toBe(false);
    expect(isHHMM('10:60')).toBe(false);
    expect(isHHMM('')).toBe(false);
    expect(isHHMM('10:0')).toBe(false);
  });
});

describe('windowShiftDeltaMin', () => {
  it('returns the signed minute delta between two times', () => {
    expect(windowShiftDeltaMin('10:00', '10:05')).toBe(5);
    expect(windowShiftDeltaMin('10:30', '10:00')).toBe(-30);
    expect(windowShiftDeltaMin('09:00', '11:15')).toBe(135);
  });
  it('returns 0 when unchanged (caller skips the request)', () => {
    expect(windowShiftDeltaMin('14:20', '14:20')).toBe(0);
  });
  it('returns null when either side is not a valid HH:MM (half-typed input)', () => {
    expect(windowShiftDeltaMin('10:00', '1:0')).toBeNull();
    expect(windowShiftDeltaMin('', '10:00')).toBeNull();
    expect(windowShiftDeltaMin('10:00', '25:00')).toBeNull();
  });
});
