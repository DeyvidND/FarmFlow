export interface CursorPos {
  createdAt: Date;
  id: string;
}

/** Opaque cursor = base64url("<iso>|<id>"). id is the tiebreaker for equal timestamps. */
export function encodeCursor(pos: CursorPos): string {
  const raw = `${pos.createdAt.toISOString()}|${pos.id}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a cursor; returns null for any malformed/forged token (treated as first page). */
export function decodeCursor(token: string): CursorPos | null {
  try {
    const raw = Buffer.from(token, 'base64url').toString('utf8');
    const idx = raw.indexOf('|');
    if (idx === -1) return null;
    const id = raw.slice(idx + 1);
    const createdAt = new Date(raw.slice(0, idx));
    if (!id || Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
