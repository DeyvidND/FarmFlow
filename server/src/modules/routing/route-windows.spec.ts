import {
  serviceMinFor,
  windowWidthMin,
  floorToMin,
  WINDOW_MIN_WIDTH_MIN,
  WINDOW_MAX_WIDTH_MIN,
} from './route-windows';

describe('serviceMinFor', () => {
  it('returns the base for a small order (no size bump)', () => {
    expect(serviceMinFor(3000, 10)).toBe(10); // 30 лв
  });
  it('bumps a medium order (>50 лв)', () => {
    expect(serviceMinFor(9000, 10)).toBe(14); // 90 лв → +4
  });
  it('bumps a large order more (>150 лв)', () => {
    expect(serviceMinFor(20000, 10)).toBe(18); // 200 лв → +8
  });
  it('never goes negative on a nonsense base', () => {
    expect(serviceMinFor(0, -5)).toBe(0);
  });
});

describe('windowWidthMin', () => {
  it('is the minimum width for the first stop (no driving yet)', () => {
    expect(windowWidthMin(0)).toBe(WINDOW_MIN_WIDTH_MIN);
  });
  it('widens with accumulated drive time', () => {
    expect(windowWidthMin(120)).toBeGreaterThan(windowWidthMin(20));
  });
  it('caps at the maximum width', () => {
    expect(windowWidthMin(10000)).toBe(WINDOW_MAX_WIDTH_MIN);
  });
  it('is rounded to 5-minute granularity', () => {
    expect(windowWidthMin(37) % 5).toBe(0);
  });
});

describe('floorToMin', () => {
  it('rounds minutes down to the granularity', () => {
    expect(floorToMin(607, 5)).toBe(605);
    expect(floorToMin(600, 15)).toBe(600);
    expect(floorToMin(614, 15)).toBe(600);
  });
});
