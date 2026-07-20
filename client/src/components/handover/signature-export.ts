/** Heuristic: a cleared/near-empty canvas exports to a very short PNG data-URL.
 *  Anything below this base64 length is treated as "no signature". */
const MIN_SIGNATURE_LEN = 1500;
export function signatureIsBlank(dataUrl: string | null | undefined): boolean {
  if (!dataUrl || !dataUrl.startsWith('data:image/png')) return true;
  const comma = dataUrl.indexOf(',');
  return comma < 0 || dataUrl.length - comma - 1 < MIN_SIGNATURE_LEN;
}
