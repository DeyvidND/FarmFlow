export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}
function firstMsg(body: unknown, fallback: string): string {
  const outer = (body as { message?: unknown })?.message;
  const inner = outer && typeof outer === 'object' && !Array.isArray(outer) ? (outer as { message?: unknown }).message : outer;
  if (Array.isArray(inner)) return typeof inner[0] === 'string' ? inner[0] : fallback;
  if (typeof inner === 'string') return inner;
  return fallback;
}
async function bff(path: string, init?: RequestInit, fallback = 'Възникна грешка'): Promise<Response> {
  const res = await fetch(`/bff/${path}`, init);
  if (!res.ok) {
    const b = await res.clone().json().catch(() => ({}));
    throw new ApiError(res.status, firstMsg(b, fallback));
  }
  return res;
}

export interface ImportRow {
  id: string;
  rowIndex: number;
  receiverName: string | null;
  receiverPhone: string | null;
  deliveryMode: 'office' | 'address' | null;
  city: string | null;
  office: string | null;
  address: string | null;
  weightGrams: number | null;
  codAmountStotinki: number | null;
  carrier: 'econt' | 'speedy';
  validationStatus: 'ok' | 'warn' | 'error';
  validation?: { issues?: Array<{ message: string }> } | null;
  shipmentId?: string | null;
}
export interface ImportBatch {
  batch: { id: string; aiReport?: { aiAvailable?: boolean } | null };
  rows: ImportRow[];
}

export const uploadBatch = async (file: File, settings: Record<string, string>): Promise<ImportBatch> => {
  const fd = new FormData();
  fd.append('file', file);
  Object.entries(settings).forEach(([k, v]) => { if (v != null && v !== '') fd.append(k, v); });
  const res = await bff('import/batches', { method: 'POST', body: fd }, 'Качването се провали');
  return res.json();
};
export const getBatch = async (id: string): Promise<ImportBatch> =>
  (await bff(`import/batches/${id}`)).json();
export const patchRow = async (batchId: string, rowId: string, patch: Partial<ImportRow>): Promise<ImportRow> =>
  (await bff(`import/batches/${batchId}/rows/${rowId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })).json();
export const deleteRow = async (batchId: string, rowId: string): Promise<void> => {
  await bff(`import/batches/${batchId}/rows/${rowId}`, { method: 'DELETE' });
};
export const commitBatch = async (batchId: string): Promise<{ results: Array<{ status: string; shipmentId?: string }>; failed?: number }> =>
  (await bff(`import/batches/${batchId}/commit`, { method: 'POST' }, 'Създаването се провали')).json();
export const downloadLabels = async (carrier: 'econt' | 'speedy', ids: string[]): Promise<void> => {
  const path = carrier === 'speedy' ? 'speedy/labels.pdf' : 'shipping/labels.pdf';
  const res = await bff(`${path}?ids=${ids.join(',')}`);
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), '_blank');
};
export const templateUrl = '/bff/import/template.xlsx';

/* ------------------------------- shipments -------------------------------- */

export type Carrier = 'econt' | 'speedy';
export type ShipmentStatus =
  | 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused';

/** A single shipment row, normalised across both carriers. Econt returns the richer
 *  `AdminShipment` shape (server); Speedy returns a slimmer `SpeedyShipment`. We tag
 *  each row with its carrier and fill the gaps with the fields each one provides. */
export interface ShipmentRow {
  carrier: Carrier;
  /** Stable row key. Econt: orderId (= shipment id for manual rows). Speedy: shipmentId. */
  rowKey: string;
  /** Persisted shipment id used by refresh / label endpoints (absent until created). */
  shipmentId?: string | null;
  receiver: string;
  method: string | null;
  status: ShipmentStatus;
  trackingNumber?: string | null;
  priceStotinki?: number | null;
  codAmountStotinki?: number | null;
  labelPdfUrl?: string | null;
}

/** Server `AdminShipment` (econt) — see econt.service.ts. */
interface EcontAdminShipment {
  orderId: string;
  orderNumber: string;
  customerName: string;
  method: 'econtOffice' | 'econtAddress';
  status: 'pending' | 'created' | 'shipped' | 'delivered';
  trackingNumber?: string;
  priceStotinki?: number;
  codAmountStotinki?: number;
  labelPdfUrl?: string;
  shipmentId?: string;
  manual?: boolean;
  history: { at: string; label: string; location?: string }[];
}

/** Server `SpeedyShipment` — see speedy.service.ts. */
interface SpeedyAdminShipment {
  shipmentId: string;
  receiverName: string;
  deliveryMode: 'office' | 'address';
  status: ShipmentStatus;
  trackingNumber: string | null;
  priceStotinki: number | null;
  codAmountStotinki: number | null;
}

const econtMethodLabel = (m: EcontAdminShipment['method']): string =>
  m === 'econtAddress' ? 'До адрес' : 'До офис';
const speedyMethodLabel = (m: SpeedyAdminShipment['deliveryMode']): string =>
  m === 'address' ? 'До адрес' : 'До офис';

export const listEcontShipments = async (): Promise<ShipmentRow[]> => {
  const rows: EcontAdminShipment[] = await (await bff('shipping/shipments')).json();
  return rows.map((r) => ({
    carrier: 'econt' as const,
    rowKey: `econt:${r.shipmentId ?? r.orderId}`,
    shipmentId: r.shipmentId ?? null,
    receiver: r.customerName,
    method: econtMethodLabel(r.method),
    status: r.status,
    trackingNumber: r.trackingNumber ?? null,
    priceStotinki: r.priceStotinki ?? null,
    codAmountStotinki: r.codAmountStotinki ?? null,
    labelPdfUrl: r.labelPdfUrl ?? null,
  }));
};

export const listSpeedyShipments = async (): Promise<ShipmentRow[]> => {
  const rows: SpeedyAdminShipment[] = await (await bff('speedy/shipments')).json();
  return rows.map((r) => ({
    carrier: 'speedy' as const,
    rowKey: `speedy:${r.shipmentId}`,
    shipmentId: r.shipmentId,
    receiver: r.receiverName,
    method: speedyMethodLabel(r.deliveryMode),
    status: r.status,
    trackingNumber: r.trackingNumber,
    priceStotinki: r.priceStotinki,
    codAmountStotinki: r.codAmountStotinki,
    labelPdfUrl: null,
  }));
};

const carrierBase = (c: Carrier) => (c === 'speedy' ? 'speedy' : 'shipping');

export const refreshShipment = async (carrier: Carrier, id: string): Promise<void> => {
  await bff(`${carrierBase(carrier)}/shipments/${id}/refresh`, { method: 'POST' }, 'Опресняването се провали');
};

export const downloadLabel = async (carrier: Carrier, id: string): Promise<void> => {
  const res = await bff(`${carrierBase(carrier)}/shipments/${id}/label.pdf`, undefined, 'Етикетът не може да се свали');
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), '_blank');
};

/* -------------------------------- COD risk -------------------------------- */

export interface RiskReport {
  source: 'internal' | 'nekorekten';
  date: string | null;
  phone: string | null;
  description: string | null;
  amountStotinki?: number | null;
}
export interface RiskCheckResult {
  phone: string | null;
  verdict: 'ok' | 'caution' | 'high';
  strikes: number;
  nekorektenCount: number;
  nekorektenConfigured: boolean;
  cached: boolean;
  reports: RiskReport[];
}
export interface RiskCandidate {
  shipmentId: string;
  receiverName: string | null;
  phone: string | null;
  codAmountStotinki: number | null;
}

export const riskCheck = async (phone: string): Promise<RiskCheckResult> =>
  (await bff(`shipping/risk/check?phone=${encodeURIComponent(phone)}`, undefined, 'Проверката се провали')).json();

export const riskCandidates = async (): Promise<RiskCandidate[]> =>
  (await bff('shipping/risk/candidates')).json();

export const riskReport = async (shipmentId: string): Promise<{ reported: true }> =>
  (await bff(`shipping/risk/reports/${shipmentId}`, { method: 'POST' }, 'Докладването се провали')).json();

/* ------------------------------- settings --------------------------------- */

/** Econt config blob (credentials stripped of the encrypted password). */
export interface EcontConfig {
  configured?: boolean;
  env?: 'demo' | 'prod';
  username?: string;
  [k: string]: unknown;
}
/** Speedy config blob (credentials stripped of the encrypted password). */
export interface SpeedyConfig {
  configured?: boolean;
  env?: 'demo' | 'prod';
  userName?: string;
  clientSystemId?: number;
  defaultServiceId?: number;
  [k: string]: unknown;
}

export interface EcontCredentialsInput {
  env?: 'demo' | 'prod';
  username: string;
  password: string;
}
export interface SpeedyCredentialsInput {
  env?: 'demo' | 'prod';
  userName: string;
  password: string;
  clientSystemId?: number;
  defaultServiceId?: number;
}

/** Account activation status (super-admin-controlled; read-only here). */
export const getAccountStatus = async (): Promise<{ active: boolean }> =>
  (await bff('shipping/account')).json();

export const getEcontConfig = async (): Promise<EcontConfig> =>
  (await bff('shipping/config')).json();
export const getSpeedyConfig = async (): Promise<SpeedyConfig> =>
  (await bff('speedy/config')).json();

export const saveEcontCredentials = async (body: EcontCredentialsInput): Promise<{ configured: true }> =>
  (await bff('shipping/credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'Запазването се провали')).json();

export const saveSpeedyCredentials = async (body: SpeedyCredentialsInput): Promise<{ configured: true }> =>
  (await bff('speedy/credentials', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'Запазването се провали')).json();
