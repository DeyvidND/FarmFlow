import { describe, expect, it } from 'vitest';
import { formatTimeDigits, isHHMM, normalizeHHMM, windowShiftDeltaMin } from './delivery-window-shift';

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

describe('formatTimeDigits', () => {
  it('masks free typing into HH:MM digits', () => {
    expect(formatTimeDigits('1530')).toBe('15:30');
    expect(formatTimeDigits('15:30')).toBe('15:30');
    expect(formatTimeDigits('15')).toBe('15');
    expect(formatTimeDigits('1')).toBe('1');
    expect(formatTimeDigits('153')).toBe('15:3');
  });
  it('drops non-digits and extra length', () => {
    expect(formatTimeDigits('15:30:45')).toBe('15:30');
    expect(formatTimeDigits('ab15c30')).toBe('15:30');
    expect(formatTimeDigits('')).toBe('');
  });
});

describe('normalizeHHMM', () => {
  it('normalizes finished entries to strict HH:MM', () => {
    expect(normalizeHHMM('15:30')).toBe('15:30');
    expect(normalizeHHMM('1530')).toBe('15:30');
    expect(normalizeHHMM('930')).toBe('09:30');
    expect(normalizeHHMM('9:30')).toBe('09:30');
    expect(normalizeHHMM('0000')).toBe('00:00');
  });
  it('rejects out-of-range, too-short and ambiguous entries', () => {
    expect(normalizeHHMM('2400')).toBeNull();
    expect(normalizeHHMM('1260')).toBeNull();
    expect(normalizeHHMM('15')).toBeNull();
    expect(normalizeHHMM('')).toBeNull();
    expect(normalizeHHMM('153099')).toBeNull();
    expect(normalizeHHMM('15:3')).toBeNull(); // half-typed minutes — never guess
    expect(normalizeHHMM('153')).toBeNull();
  });
});
