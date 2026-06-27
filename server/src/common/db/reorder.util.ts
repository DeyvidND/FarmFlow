import { sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

/**
 * Build a `CASE WHEN <idCol> = id THEN pos … ELSE <posCol> END` expression so a
 * reorder persists in ONE `UPDATE` instead of one statement per row. Rows whose id
 * isn't in `items` keep their current position (the ELSE branch), so pair this with
 * a `WHERE <idCol> IN (ids) AND <scope>`. Empty `items` → caller should skip the update.
 */
export function positionCase(
  idCol: AnyPgColumn,
  posCol: AnyPgColumn,
  items: { id: string; position: number }[],
): SQL {
  const whens = items.map((it) => sql`when ${idCol} = ${it.id} then ${it.position}`);
  return sql`case ${sql.join(whens, sql` `)} else ${posCol} end`;
}
