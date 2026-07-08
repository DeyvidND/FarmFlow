/**
 * Heuristic: does this delivery address sit on a MAJOR road (boulevard / trunk /
 * European route) where a courier can't reasonably stop? There is no Google API
 * for "road size", so we read the Bulgarian address string: `бул.`/`булевард`,
 * `шосе`, `магистрала`, or a European-route token (`E87`, `Е-85` — Latin or
 * Cyrillic „Е"). Flagged stops get a gentle „move the pin to a side street"
 * nudge; the operator confirms. Pure, deterministic, case-insensitive.
 */
export function isMajorRoadAddress(address: string | null): boolean {
  if (!address) return false;
  const s = address.toLowerCase();
  // Standalone „бул" / „бул." token. JS `\b` is ASCII-only and never fires next
  // to Cyrillic, so bound the token explicitly with start / whitespace / punct.
  if (/(^|[\s,.])бул\.?(\s|[,.]|$)/.test(s)) return true;
  if (/булевард|шосе|магистрала/.test(s)) return true;
  // European route: E or Cyrillic Е, optional dash/space, 2-3 digits (E87, Е-85).
  if (/(^|[^a-zа-я0-9])[eе][-\s]?\d{2,3}\b/i.test(address)) return true;
  return false;
}
