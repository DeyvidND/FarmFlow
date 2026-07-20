/**
 * Best-effort settlement name for the „Днес, …, в гр./с. X" clause on a protocol,
 * parsed from a free-text legal address. Matches „гр."/„град"/„с."/„село" then up
 * to two capitalized words. null when nothing recognizable — the caller drops the
 * clause gracefully. Heuristic by design (addresses are unstructured).
 */
const SETTLEMENT =
  // Abbreviations REQUIRE their dot (`гр.` / `с.`) but allow no space after it —
  // „гр.Варна" is written at least as often as „гр. Варна". Requiring the dot is what
  // keeps the one-letter `с.` from swallowing the ordinary Bulgarian preposition „с"
  // („с ЕГН…" must NOT parse as the village „ЕГН"). Full words need no dot but do
  // need a space. Name = one or two capitalised words.
  /(?:^|[\s,])(?:(гр|с)\.\s*|(град|село)\s+)([А-ЯA-Z][А-Яа-яA-Za-z-]+(?:\s+[А-ЯA-Z][А-Яа-яA-Za-z-]+)?)/u;

export function cityFromAddress(address?: string | null): { prefix: string; name: string } | null {
  if (!address) return null;
  const m = address.match(SETTLEMENT);
  if (!m) return null;
  const [, abbr, full, name] = m;
  return { prefix: abbr === 'с' || full === 'село' ? 'с.' : 'гр.', name };
}
