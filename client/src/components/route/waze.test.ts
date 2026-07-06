import { describe, it, expect } from 'vitest';
import { wazeUrl, buildWazeTargets } from './waze';
import type { RouteStop, RouteEnd } from '@/lib/types';

const stop = (over: Partial<RouteStop>): RouteStop => ({
  id: 'x', customer: null, phone: null, email: null, address: null,
  note: null, lat: null, lng: null, summary: '', slotFrom: null, slotTo: null,
  ...over,
});

describe('wazeUrl', () => {
  it('uses ll for coords with the comma encoded', () => {
    expect(wazeUrl({ lat: 43.2, lng: 27.9, address: 'ignored' })).toBe(
      'https://www.waze.com/ul?ll=43.2%2C27.9&navigate=yes',
    );
  });
  it('falls back to q for address only', () => {
    expect(wazeUrl({ lat: null, lng: null, address: 'с. Звездица' })).toBe(
      `https://www.waze.com/ul?q=${encodeURIComponent('с. Звездица')}&navigate=yes`,
    );
  });
  it('returns null when there is neither coords nor a real address', () => {
    expect(wazeUrl({ lat: null, lng: null, address: '  ' })).toBeNull();
  });
});

describe('buildWazeTargets', () => {
  const origin = { lat: 43.0, lng: 27.0, address: 'база' };
  const end = (over: Partial<RouteEnd>): RouteEnd =>
    ({ mode: 'home', address: null, lat: null, lng: null, ...over });

  it('orders the stops and labels them „Спирка N"', () => {
    const t = buildWazeTargets(
      [stop({ id: 'a', lat: 1, lng: 1 }), stop({ id: 'b', lat: 2, lng: 2 })],
      end({ mode: 'last' }),
      origin,
    );
    expect(t.map((x) => x.key)).toEqual(['a', 'b']);
    expect(t[0].label).toBe('Спирка 1');
    expect(t[1].label).toBe('Спирка 2');
  });

  it('appends a base target when returning home, using origin for an empty end', () => {
    const t = buildWazeTargets([stop({ id: 'a', lat: 1, lng: 1 })], end({ mode: 'home', address: '' }), origin);
    const last = t[t.length - 1];
    expect(last.key).toBe('base');
    expect(last.lat).toBe(43.0);
    expect(last.label).toBe('Обратно към базата');
  });

  it('uses an explicit end point when the end has its own coords', () => {
    const t = buildWazeTargets(
      [stop({ id: 'a', lat: 1, lng: 1 })],
      end({ mode: 'custom', lat: 42.5, lng: 25.5, address: 'друг адрес' }),
      origin,
    );
    expect(t[t.length - 1].key).toBe('base');
    expect(t[t.length - 1].lat).toBe(42.5);
  });

  it('omits the base target when end.mode is "last"', () => {
    const t = buildWazeTargets([stop({ id: 'a', lat: 1, lng: 1 })], end({ mode: 'last' }), origin);
    expect(t.some((x) => x.key === 'base')).toBe(false);
  });
});
