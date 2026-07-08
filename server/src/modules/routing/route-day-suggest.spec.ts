import { suggestDayAssignment, type SuggestOrder } from './route-day-suggest';

const depot = { lat: 42.65, lng: 23.32 };
const north1: SuggestOrder = { id: 'n1', lat: 42.71, lng: 23.32 };
const north2: SuggestOrder = { id: 'n2', lat: 42.72, lng: 23.33 };
const north3: SuggestOrder = { id: 'n3', lat: 42.73, lng: 23.31 };
const south1: SuggestOrder = { id: 's1', lat: 42.58, lng: 23.32 };
const south2: SuggestOrder = { id: 's2', lat: 42.57, lng: 23.33 };
const south3: SuggestOrder = { id: 's3', lat: 42.56, lng: 23.31 };

const dayIds = (routes: string[][]) => routes.flat();

describe('suggestDayAssignment (per-day couriers)', () => {
  it('gives a day with more couriers more orders (capacity-weighted)', () => {
    const orders = [north1, north2, north3, south1, south2, south3];
    const { assignment } = suggestDayAssignment(
      orders,
      [{ date: '2026-07-10', couriers: 2 }, { date: '2026-07-11', couriers: 1 }],
      depot,
    );
    const d1 = dayIds(assignment['2026-07-10']);
    const d2 = dayIds(assignment['2026-07-11']);
    expect(d1.length + d2.length).toBe(6);
    expect(d1.length).toBeGreaterThan(d2.length); // 2 couriers > 1 courier share
  });

  it('never gives a day more routes than its courier count', () => {
    const orders = [north1, north2, north3, south1, south2, south3];
    const { assignment } = suggestDayAssignment(
      orders,
      [{ date: '2026-07-10', couriers: 2 }, { date: '2026-07-11', couriers: 1 }],
      depot,
    );
    expect(assignment['2026-07-10'].length).toBeLessThanOrEqual(2);
    expect(assignment['2026-07-11'].length).toBeLessThanOrEqual(1);
  });

  it('routes un-geocoded orders to unplaced, never onto a day', () => {
    const { assignment, unplaced } = suggestDayAssignment(
      [north1, { id: 'x', lat: null, lng: null }],
      [{ date: '2026-07-10', couriers: 1 }],
      depot,
    );
    expect(unplaced).toEqual(['x']);
    expect(dayIds(assignment['2026-07-10'])).toEqual(['n1']);
  });

  it('each assignment value is an array of routes (string[][])', () => {
    const { assignment } = suggestDayAssignment(
      [north1, south1],
      [{ date: '2026-07-10', couriers: 1 }],
      depot,
    );
    expect(Array.isArray(assignment['2026-07-10'])).toBe(true);
    expect(Array.isArray(assignment['2026-07-10'][0])).toBe(true);
  });

  it('is deterministic', () => {
    const orders = [north1, south1, north2, south2];
    const days = [{ date: '2026-07-10', couriers: 1 }, { date: '2026-07-11', couriers: 1 }];
    expect(suggestDayAssignment(orders, days, depot)).toEqual(
      suggestDayAssignment(orders, days, depot),
    );
  });

  it('puts all located orders in unplaced when no days are given', () => {
    const { assignment, unplaced } = suggestDayAssignment([north1, south1], [], depot);
    expect(assignment).toEqual({});
    expect(unplaced.sort()).toEqual(['n1', 's1']);
  });

  it('empty days keys present with no routes when there are no located orders', () => {
    const { assignment, unplaced } = suggestDayAssignment(
      [{ id: 'x', lat: null, lng: null }],
      [{ date: '2026-07-10', couriers: 2 }],
      depot,
    );
    expect(assignment).toEqual({ '2026-07-10': [] });
    expect(unplaced).toEqual(['x']);
  });
});
