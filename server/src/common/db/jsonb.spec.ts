import { PgDialect } from 'drizzle-orm/pg-core';
import { tenants } from '@fermeribg/db';
import { jsonbDeepMerge } from './jsonb';

/**
 * jsonbDeepMerge must emit an ATOMIC, sibling-preserving merge — the antidote to
 * the read-modify-write-whole-blob clobber that loses a concurrent writer's edit.
 * We render the SQL and assert its shape: a `||` merge at every path level (so
 * untouched siblings survive) and the column re-read at every level (so it merges
 * into the row's CURRENT value rather than overwriting the whole column with a
 * value computed from a stale read).
 */
const dialect = new PgDialect();
const render = (path: string[], value: unknown) =>
  dialect.sqlToQuery(jsonbDeepMerge(tenants.settings, path, value));

describe('jsonbDeepMerge', () => {
  it('throws on an empty path', () => {
    expect(() => jsonbDeepMerge(tenants.settings, [], {})).toThrow();
  });

  it('binds every key and the JSON value as parameters (no interpolation)', () => {
    const { params } = render(['delivery', 'farmers', 'f1', 'econt'], { configured: true });
    expect(params).toEqual(
      expect.arrayContaining(['delivery', 'farmers', 'f1', 'econt', JSON.stringify({ configured: true })]),
    );
  });

  it('merges (||) at every path level so sibling subtrees are preserved', () => {
    const { sql: text } = render(['delivery', 'farmers', 'f1', 'econt'], { configured: true });
    // one `||` concatenation per path level → four
    expect(text.match(/\|\|/g)?.length).toBe(4);
    expect(text).toContain('jsonb_build_object');
    // the column is re-read at every level (coalesce(col -> key, '{}')), proving a
    // merge-into-current rather than a whole-column overwrite from a stale value.
    expect((text.match(/"tenants"\."settings"/g)?.length ?? 0)).toBeGreaterThanOrEqual(4);
  });

  it('casts the leaf value to jsonb', () => {
    const { sql: text } = render(['delivery', 'econt'], { username: 'u' });
    expect(text).toContain('::jsonb');
    expect(text.match(/\|\|/g)?.length).toBe(2);
  });
});
