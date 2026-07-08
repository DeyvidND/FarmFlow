import { suggestDayAssignment, type SuggestOrder } from './route-day-suggest';

const depot = { lat: 42.65, lng: 23.32 };

// Two clear clusters: two "north" points and two "south" points.
const north1: SuggestOrder = { id: 'n1', lat: 42.71, lng: 23.32 };
const north2: SuggestOrder = { id: 'n2', lat: 42.72, lng: 23.33 };
const south1: SuggestOrder = { id: 's1', lat: 42.58, lng: 23.32 };
const south2: SuggestOrder = { id: 's2', lat: 42.57, lng: 23.33 };

/** The day (its id list) that contains `id`. */
function dayOf(assignment: Record<string, string[]>, id: string): string[] | undefined {
  return Object.values(assignment).find((ids) => ids.includes(id));
}

describe('suggestDayAssignment', () => {
  it('keeps geographic clusters together across 2 days', () => {
    const orders = [north1, south1, north2, south2];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11'], depot);

    expect(unplaced).toEqual([]);
    // Every chosen day is a key.
    expect(Object.keys(assignment).sort()).toEqual(['2026-07-10', '2026-07-11']);
    // The two north orders land on the same day; likewise the two south orders.
    expect(dayOf(assignment, 'n1')).toEqual(dayOf(assignment, 'n2'));
    expect(dayOf(assignment, 's1')).toEqual(dayOf(assignment, 's2'));
    // North and south are on different days.
    expect(dayOf(assignment, 'n1')).not.toEqual(dayOf(assignment, 's1'));
  });

  it('routes un-geocoded orders to unplaced, never onto a day', () => {
    const orders: SuggestOrder[] = [north1, { id: 'x', lat: null, lng: null }];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10'], depot);
    expect(unplaced).toEqual(['x']);
    expect(Object.values(assignment).flat()).toEqual(['n1']);
  });

  it('puts all located orders on the single day when N=1', () => {
    const orders = [north1, south1, north2];
    const { assignment } = suggestDayAssignment(orders, ['2026-07-10'], depot);
    expect(assignment['2026-07-10'].sort()).toEqual(['n1', 'n2', 's1']);
  });

  it('is deterministic', () => {
    const orders = [north1, south1, north2, south2];
    const a = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11'], depot);
    const b = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11'], depot);
    expect(a).toEqual(b);
  });

  it('falls back to the stop centroid when no depot is given', () => {
    const orders = [north1, north2, south1, south2];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11'], null);
    expect(unplaced).toEqual([]);
    expect(Object.values(assignment).flat().sort()).toEqual(['n1', 'n2', 's1', 's2']);
  });

  it('returns empty day lists when there are no located orders', () => {
    const orders: SuggestOrder[] = [{ id: 'x', lat: null, lng: null }];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10'], depot);
    expect(assignment).toEqual({ '2026-07-10': [] });
    expect(unplaced).toEqual(['x']);
  });

  it('puts every order in unplaced when no days are given', () => {
    const orders = [north1, south1];
    const { assignment, unplaced } = suggestDayAssignment(orders, [], depot);
    expect(assignment).toEqual({});
    expect(unplaced).toEqual(['n1', 's1']);
  });

  it('leaves extra days empty when there are more days than orders', () => {
    const orders = [north1, south1];
    const { assignment, unplaced } = suggestDayAssignment(orders, ['2026-07-10', '2026-07-11', '2026-07-12'], depot);
    expect(Object.keys(assignment).sort()).toEqual(['2026-07-10', '2026-07-11', '2026-07-12']);
    const allPlaced = Object.values(assignment).flat().sort();
    expect(allPlaced).toEqual(['n1', 's1']);
    expect(Object.values(assignment).some((ids) => ids.length === 0)).toBe(true);
    expect(unplaced).toEqual([]);
  });
});
