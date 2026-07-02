export interface CursorPos {
  /**
   * Micro-precision, tz-naive timestamp string of the boundary row, e.g.
   * `2026-07-02T12:00:00.123456`. NOT a JS Date: node-postgres parses a Postgres
   * `timestamp` (microsecond precision) into a JS Date, which is millisecond-only,
   * silently dropping the micros. If >LIMIT rows share a millisecond (a bulk
   * import stamped with one `now()`), a ms-truncated cursor bound lands *below*
   * every such row, so the `(created_at, id)` row-value compare is satisfied by
   * the timestamp alone — the id tiebreaker never engages and the page never
   * advances (the stall). Carrying the full-precision string keeps the boundary
   * exact so pagination always strictly advances. Produce it in the query with
   * {@link cursorTs}; never round-trip it through a JS Date.
   */
  createdAt: string;
  id: string;
}

/** Opaque cursor = base64url("<ts>|<id>"). id is the tiebreaker for equal timestamps. */
export function encodeCursor(pos: CursorPos): string {
  const raw = `${pos.createdAt}|${pos.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a cursor; returns null for any malformed/forged token (treated as first page). */
export function decodeCursor(token: string): CursorPos | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const idx = raw.indexOf('|');
    if (idx === -1) return null;
    const id = raw.slice(idx + 1);
    const createdAt = raw.slice(0, idx);
    // Keep the raw micro-precision string verbatim (a `new Date()` would truncate
    // it back to milliseconds and reintroduce the stall). Only sanity-check that
    // the timestamp half is parseable — this also accepts pre-fix `…Z` cursors
    // still in flight during a deploy, so old links don't reset to page 1.
    if (!id || !createdAt || Number.isNaN(new Date(createdAt).getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
