/**
 * Estimate how many SMS segments `body` will use. GSM-7 messages fit 160 chars
 * (153 per part when multipart); any non-GSM-7 char (e.g. Cyrillic) forces
 * UCS-2 at 70 chars (67 per part when multipart). We only need a good-enough
 * count for cost accounting, so we treat "has a non-GSM-7 char" as UCS-2.
 */
const GSM7 =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ ÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';

function isGsm7(body: string): boolean {
  for (const ch of body) {
    if (!GSM7.includes(ch)) return false;
  }
  return true;
}

export function smsSegments(body: string): number {
  if (body.length === 0) return 1;
  const ucs2 = !isGsm7(body);
  const single = ucs2 ? 70 : 160;
  const multi = ucs2 ? 67 : 153;
  const len = ucs2 ? [...body].length : body.length;
  if (len <= single) return 1;
  return Math.ceil(len / multi);
}
