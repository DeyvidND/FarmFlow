import { PgDialect } from 'drizzle-orm/pg-core';
import { productVariants } from '@fermeribg/db';
import { intCaseById } from './order-stock.util';

const render = (expr: ReturnType<typeof intCaseById>) =>
  new PgDialect().sqlToQuery(expr!);

describe('intCaseById', () => {
  it('returns null when there is nothing to update (no wasted UPDATE)', () => {
    expect(intCaseById(productVariants.id, [])).toBeNull();
  });

  it('builds one searched-CASE arm per row, binding id and value as params', () => {
    const { sql, params } = render(
      intCaseById(productVariants.id, [{ id: 'aaaa', value: 7 }]),
    );
    expect(sql.toLowerCase()).toContain('case');
    expect(sql.toLowerCase()).toContain('when');
    expect(sql.toLowerCase()).toContain('then');
    expect(sql.toLowerCase()).toContain('end');
    // id compared against the variant id column, value applied.
    expect(params).toEqual(['aaaa', 7]);
  });

  it('casts the id to ::uuid and the value to ::int (drizzle/pg will not infer a bare CASE arm)', () => {
    const { sql } = render(intCaseById(productVariants.id, [{ id: 'aaaa', value: 7 }]));
    expect(sql).toContain('::uuid');
    expect(sql).toContain('::int');
  });

  it('emits N arms in order for N rows, one (id, value) param pair each', () => {
    const { sql, params } = render(
      intCaseById(productVariants.id, [
        { id: 'id-1', value: 10 },
        { id: 'id-2', value: 0 },
        { id: 'id-3', value: 999 },
      ]),
    );
    // three WHEN arms
    expect(sql.toLowerCase().match(/when/g)).toHaveLength(3);
    expect(params).toEqual(['id-1', 10, 'id-2', 0, 'id-3', 999]);
  });

  it('references the passed id column, so the same builder serves any table', () => {
    const { sql } = render(intCaseById(productVariants.id, [{ id: 'x', value: 1 }]));
    expect(sql).toContain('"product_variants"."id"');
  });
});
