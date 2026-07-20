/**
 * Best-effort settlement name for the „Днес, …, в гр./с. X" clause on a protocol,
 * parsed from a free-text legal address. Matches „гр."/„град"/„с."/„село" then up
 * to two capitalized words. null when nothing recognizable — the caller drops the
 * clause gracefully. Heuristic by design (addresses are unstructured).
 */
export function cityFromAddress(address?: string | null): { prefix: string; name: string } | null {
  if (!address) return null;
  const m = address.match(
    /(?:^|[\s,])(гр|град|с|село)\.?\s+([А-ЯA-Z][А-Яа-яA-Za-z-]+(?:\s+[А-ЯA-Z][А-Яа-яA-Za-z-]+)?)/u,
  );
  if (!m) return null;
  const name = m[2].trim().replace(/[.,]+$/, '');
  if (!name) return null;
  const prefix = /^гр|^град/i.test(m[1]) ? 'гр.' : 'с.';
  return { prefix, name };
}
