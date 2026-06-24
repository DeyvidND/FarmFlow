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

/** Unified risk record — our strikes and nekorekten reports share this shape so one
 *  frontend component renders both. `source` is the only discriminator. */
export interface RiskReport {
  source: 'internal' | 'nekorekten';
  date: string | null; // ISO
  phone: string | null;
  description: string | null;
  amountStotinki?: number | null; // internal extra; nekorekten reports omit it
}

export interface RiskCheckResult {
  phone: string | null;
  verdict: RiskVerdict;
  strikes: number;
  nekorektenCount: number;
  nekorektenConfigured: boolean;
  cached: boolean; // true = no nekorekten API call was made this request
  reports: RiskReport[];
}

function toIso(d: Date | string | null | undefined): string | null {
  if (d == null) return null;
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/** Our returned-COD events → unified reports. Non-`returned` rows are dropped. */
export function toInternalReports(
  events: Array<{ createdAt: Date | string | null; phone: string | null; type: string | null }>,
  phone: string,
): RiskReport[] {
  return events
    .filter((e) => (e.type ?? '') === 'returned')
    .map((e) => ({
      source: 'internal' as const,
      date: toIso(e.createdAt),
      phone: e.phone ?? phone,
      description: 'Върната/невзета COD пратка',
    }));
}

/** nekorekten reports → unified reports. */
export function toNekorektenReports(nk: NekorektenCheck): RiskReport[] {
  return nk.reports.map((r) => ({
    source: 'nekorekten' as const,
    date: r.date,
    phone: r.phone,
    description: r.description,
  }));
}

/** Internal records first, then external. */
export function mergeReports(internal: RiskReport[], external: RiskReport[]): RiskReport[] {
  return [...internal, ...external];
}
