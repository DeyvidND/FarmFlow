import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/**
 * Build an SQL expression that sets `value` at `path` inside a jsonb `column`,
 * deep-creating any missing intermediate objects and PRESERVING every untouched
 * sibling subtree. It is the atomic, race-safe replacement for the classic
 * read-the-whole-blob → mutate-one-key-in-JS → write-the-whole-column pattern,
 * which loses a concurrent writer's edit (last-writer-wins on the ENTIRE blob).
 *
 * Emits nested `coalesce(x, '{}') || jsonb_build_object(key, child)` — a `||`
 * merge at every level of the path — so two writers targeting DIFFERENT paths
 * (e.g. two co-op farmers each connecting their own carrier, or one farmer
 * connecting Econt and Speedy at once) never clobber each other: each level
 * concatenates its key into the OTHER writer's committed object rather than
 * overwriting it.
 *
 * Keys and the value are bound as parameters (never string-interpolated), so a
 * path segment such as a farmerId can't inject SQL.
 *
 * Use as: `.set({ settings: jsonbDeepMerge(tenants.settings, path, value) })`.
 *
 * Note: the leaf `value` still replaces whatever object currently sits at the
 * FULL path — this serializes writers at different paths, not two writers at the
 * exact same leaf. For same-leaf concurrency, serialize with a row/advisory lock.
 */
export function jsonbDeepMerge(column: SQLWrapper, path: string[], value: unknown): SQL {
  if (path.length === 0) throw new Error('jsonbDeepMerge: path must be non-empty');
  const json = JSON.stringify(value ?? null);
  const build = (colExpr: SQL, keys: string[]): SQL => {
    const [head, ...rest] = keys;
    const child: SQL =
      rest.length === 0
        ? sql`${json}::jsonb`
        : build(sql`coalesce(${colExpr} -> ${head}, '{}'::jsonb)`, rest);
    return sql`coalesce(${colExpr}, '{}'::jsonb) || jsonb_build_object(${head}::text, ${child})`;
  };
  return build(sql`${column}`, path);
}
