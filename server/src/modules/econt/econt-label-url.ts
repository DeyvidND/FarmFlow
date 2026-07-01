/**
 * Allowlist for label-PDF fetches. `fetchLabelPdf` attaches the farm's Basic
 * credentials, so the target host must be Econt and nothing else — a stray
 * `shipments.labelPdfUrl` must never be able to exfiltrate those creds.
 * Econt serves labels from ee.econt.com (prod) and demo.econt.com (demo).
 */
export function isEcontLabelUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'econt.com' || host.endsWith('.econt.com');
}
