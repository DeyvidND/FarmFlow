import { humanizeStopOrder } from './route-humanize';
import type { Pt } from './route-split';

interface S {
  id: string;
  lat: number;
  lng: number;
}
const s = (id: string, lat: number, lng: number): S => ({ id, lat, lng });
const ptOf = (x: S): Pt => ({ lat: x.lat, lng: x.lng });
const ids = (arr: S[]) => arr.map((x) => x.id);

// A depot due west of a straight east-running line of stops. On this line the
// crow-flies-optimal visit order is simply left-to-right.
const depot: Pt = { lat: 0, lng: 0 };

describe('humanizeStopOrder', () => {
  it('pulls a driven-past stop out of "last" and into travel sequence', () => {
    // C sits between A and B, but the optimizer left it last (the "+30s" artifact).
    const A = s('A', 0, 1);
    const B = s('B', 0, 3);
    const C = s('C', 0, 2);
    // Google-style order: A, B, then back for C.
    const out = humanizeStopOrder(depot, [A, B, C], null, ptOf);
    expect(ids(out)).toEqual(['A', 'C', 'B']);
  });

  it('leaves an already-sequential order unchanged', () => {
    const line = [s('1', 0, 1), s('2', 0, 2), s('3', 0, 3), s('4', 0, 4)];
    const out = humanizeStopOrder(depot, line, null, ptOf);
    expect(ids(out)).toEqual(['1', '2', '3', '4']);
  });

  it('un-crosses a crossing via 2-opt (round trip back to depot)', () => {
    // Four corners of a square; a crossing order (diagonal hops) should become
    // the convex loop 1→2→3→4 when we must return to the depot.
    const p1 = s('1', 0, 1);
    const p2 = s('2', 1, 1);
    const p3 = s('3', 1, 0.2);
    const p4 = s('4', 0, 0.2);
    // Crossed order: 1, 3, 2, 4 (hops across the square).
    const out = humanizeStopOrder(depot, [p1, p3, p2, p4], depot, ptOf);
    // Any rotation/reflection that forms the non-crossing loop is acceptable;
    // assert the total length dropped below the crossed input's length.
    const len = (arr: S[]) => {
      const pts = [depot, ...arr.map(ptOf), depot];
      let d = 0;
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        d += Math.hypot(a.lat - b.lat, a.lng - b.lng);
      }
      return d;
    };
    expect(len(out)).toBeLessThan(len([p1, p3, p2, p4]));
  });

  it('returns the input untouched when a stop is un-geocoded', () => {
    const A = s('A', 0, 1);
    const bad = { id: 'B', lat: 0, lng: 3 } as S;
    const out = humanizeStopOrder(
      depot,
      [A, bad],
      null,
      (x) => (x.id === 'B' ? null : ptOf(x)),
    );
    expect(ids(out)).toEqual(['A', 'B']);
  });

  it('is a no-op for zero or one stop', () => {
    expect(humanizeStopOrder(depot, [], null, ptOf)).toEqual([]);
    const one = [s('only', 0, 1)];
    expect(ids(humanizeStopOrder(depot, one, null, ptOf))).toEqual(['only']);
  });

  it('does not mutate the caller\'s array', () => {
    const A = s('A', 0, 1);
    const B = s('B', 0, 3);
    const C = s('C', 0, 2);
    const input = [A, B, C];
    humanizeStopOrder(depot, input, null, ptOf);
    expect(ids(input)).toEqual(['A', 'B', 'C']);
  });
});
