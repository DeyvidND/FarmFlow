import { describe, expect, it } from 'vitest';
import { hasPinCausedImbalance, type ImbalanceRoute } from './pin-imbalance';

/** A stop with `courierIndex: null` is a free/auto stop; a number means pinned. */
const stop = (courierIndex: number | null) => ({ courierIndex });

const route = (stops: { courierIndex: number | null }[], totalDurationS: number | null = null): ImbalanceRoute => ({
  stops,
  totalDurationS,
});

describe('hasPinCausedImbalance', () => {
  it('is false when there are no pins at all (any imbalance is just geography)', () => {
    const routes = [
      route(Array.from({ length: 8 }, () => stop(null))),
      route(Array.from({ length: 1 }, () => stop(null))),
    ];
    expect(hasPinCausedImbalance(routes)).toBe(false);
  });

  it('is false when pins exist but the split is balanced', () => {
    const routes = [
      route([stop(0), stop(null), stop(null), stop(null)]),
      route([stop(null), stop(null), stop(null), stop(null)]),
    ];
    expect(hasPinCausedImbalance(routes)).toBe(false);
  });

  it('is true when pins exist and the couriers with free stops are meaningfully imbalanced', () => {
    // Courier 0 is pinned-heavy AND still gets a big share of the free stops
    // (the exact bug this hint explains) — 8 free stops vs 1 free stop.
    const routes = [
      route([stop(0), stop(0), stop(0), stop(0), ...Array.from({ length: 8 }, () => stop(null))]),
      route([stop(null)]),
    ];
    expect(hasPinCausedImbalance(routes)).toBe(true);
  });

  it('ignores a courier with ONLY pinned stops (no free stops) when comparing balance', () => {
    // Courier 0 has 6 pinned stops and zero free ones — legitimately small
    // free-stop count, not something the free-stop balance should flag.
    // Courier 1 and 2 both have free stops and are balanced (4 vs 4).
    const routes = [
      route(Array.from({ length: 6 }, () => stop(0))),
      route(Array.from({ length: 4 }, () => stop(null))),
      route(Array.from({ length: 4 }, () => stop(null))),
    ];
    expect(hasPinCausedImbalance(routes)).toBe(false);
  });

  it('needs at least two couriers with free stops to compare — a single free-stop courier is not an imbalance', () => {
    const routes = [
      route(Array.from({ length: 6 }, () => stop(0))),
      route(Array.from({ length: 4 }, () => stop(null))),
    ];
    expect(hasPinCausedImbalance(routes)).toBe(false);
  });

  it('prefers totalDurationS over stop count when available', () => {
    // Stop counts look balanced (3 vs 3) but the measured drive time is
    // wildly skewed — the duration signal should still catch it.
    const routes = [
      route(
        [stop(0), stop(null), stop(null), stop(null)],
        10000, // ~2.8h
      ),
      route([stop(null), stop(null), stop(null)], 600), // 10min
    ];
    expect(hasPinCausedImbalance(routes)).toBe(true);
  });

  it('does not flag a small, noisy difference between free-stop couriers', () => {
    const routes = [
      route([stop(0), stop(null), stop(null)]),
      route([stop(null)]),
    ];
    // 2 free vs 1 free — ratio-wise "imbalanced" but too small in absolute
    // terms to be worth an inline hint.
    expect(hasPinCausedImbalance(routes)).toBe(false);
  });
});
