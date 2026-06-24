/** Canonicalize a Bulgarian phone to E.164 (+359XXXXXXXXX), or null if unparseable. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = raw.replace(/[^\d+]/g, ''); // keep digits + leading plus
  if (d.startsWith('+359')) d = d.slice(4);
  else if (d.startsWith('00359')) d = d.slice(5);
  else if (d.startsWith('359') && d.length === 12) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  d = d.replace(/\D/g, '');
  // BG national numbers are 9 digits after the country/trunk prefix.
  if (d.length !== 9) return null;
  return `+359${d}`;
}

export type RiskVerdict = 'ok' | 'caution' | 'high';

/** Combine our own strike count + nekorekten report count into a verdict. */
export function riskVerdict(internalStrikes: number, nekorektenCount: number): RiskVerdict {
  if (internalStrikes >= 2 || nekorektenCount >= 2) return 'high';
  if (internalStrikes >= 1 || nekorektenCount >= 1) return 'caution';
  return 'ok';
}

/** True when an Econt status string means the parcel came back / was refused. */
export function isReturnedStatus(status: string | null | undefined): boolean {
  const s = (status ?? '').toLowerCase();
  if (!s) return false;
  return (
    s.includes('върнат') || s.includes('отказ') || s.includes('return') || s.includes('refus')
  );
}

export interface NekorektenReport {
  date: string | null;
  phone: string | null;
  description: string | null;
}
export interface NekorektenCheck {
  configured: boolean;
  found: boolean;
  count: number;
  reports: NekorektenReport[];
}

/** Defensively read nekorekten's GET /reports response (shape unconfirmed vs live). */
export function parseReports(res: unknown): NekorektenCheck {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r)
    ? r
    : Array.isArray(r.reports)
      ? r.reports
      : Array.isArray(r.data)
        ? r.data
        : [];
  const reports: NekorektenReport[] = list.map((x) => ({
    date: x?.createdAt ?? x?.date ?? null,
    phone: x?.phone ?? null,
    description: x?.text ?? x?.description ?? null,
  }));
  return { configured: true, found: reports.length > 0, count: reports.length, reports };
}

/** The Bulgarian report text sent to nekorekten for a refused COD parcel. */
export function buildReportText(shipment: {
  codAmountStotinki: number | null;
  receiverName?: string | null;
}): string {
  const amount = shipment.codAmountStotinki != null ? ` (${(shipment.codAmountStotinki / 100).toFixed(2)} EUR)` : '';
  return `Отказана/невзета пратка с наложен платеж${amount}. Клиентът не получи пратката.`;
}
