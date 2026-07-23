/**
 * Allowlist + normalization for label-PDF fetches. `fetchLabelPdf` attaches the
 * farm's Basic credentials, so the target host must be Econt and nothing else — a
 * stray `shipments.labelPdfUrl` must never be able to exfiltrate those creds.
 * Econt serves labels from ee.econt.com (prod) and demo.econt.com (demo); the demo
 * API hands back plain `http://` label urls, so the scheme is upgraded to https
 * (both hosts serve TLS) rather than sending Basic auth in cleartext.
 * Returns the https URL to fetch, or null when the URL is not an Econt label.
 */
export function normalizeEcontLabelUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'econt.com' && !host.endsWith('.econt.com')) return null;
  url.protocol = 'https:';
  return url.href;
}
