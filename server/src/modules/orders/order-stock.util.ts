import { SQL, sql } from 'drizzle-orm';
import { PgColumn } from 'drizzle-orm/pg-core';

/**
 * Build a searched `CASE WHEN id = … THEN value … END` expression so a set of
 * per-row *absolute* integer updates collapses into ONE
 * `UPDATE <table> SET <col> = <case> WHERE id IN (ids)` instead of N single-row
 * UPDATEs in a loop. Used on the checkout / order-edit / cancel paths, where the
 * loop persists variant stock and availability-window remaining while those rows
 * are held under `FOR UPDATE`: fewer round-trips = shorter lock-hold on the popular
 * SKU rows = less serialization of concurrent checkouts.
 *
 * The id is cast `::uuid` (a bound param is otherwise `text`, and `uuid = text` has
 * no operator) and the value `::int` — drizzle/pg will not infer the type of a bare
 * CASE arm (the repo's documented `CASE…THEN needs ::int` gotcha). Returns null when
 * `rows` is empty so the caller can skip the UPDATE entirely.
 */
export function intCaseById(
  idColumn: PgColumn,
  rows: { id: string; value: number }[],
): SQL | null {
  if (rows.length === 0) return null;
  const arms = rows.map((r) => sql`when ${idColumn} = ${r.id}::uuid then ${r.value}::int`);
  return sql`case ${sql.join(arms, sql` `)} end`;
}
