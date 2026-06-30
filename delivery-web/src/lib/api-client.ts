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
  validation?: { issues?: Array<{ message: string; field?: string; code?: string; suggestion?: string }> } | null;
  shipmentId?: string | null;
}
export interface ImportBatch {
  batch: { id: string; aiReport?: { aiAvailable?: boolean } | null };
  rows: ImportRow[];
}

export const uploadBatch = async (file: File, settings: Record<string, string> = {}): Promise<ImportBatch> => {
  const fd = new FormData();
  fd.append('file', file);
  Object.entries(settings).forEach(([k, v]) => { if (v != null && v !== '') fd.append(k, v); });
  const res = await bff('import/batches', { method: 'POST', body: fd }, 'Качването се провали');
  return res.json();
};

/* --------------------------- cheapest-courier quote ----------------------- */

export interface CarrierQuote {
  carrier: 'econt' | 'speedy';
  priceStotinki: number | null;
  available: boolean;
}
export interface QuoteResult {
  quotes: CarrierQuote[];
  cheapest: 'econt' | 'speedy' | null;
}

/** Price both carriers for a destination. When `codAmountStotinki` is supplied the
 *  COD surcharge is folded into each carrier's quote, so the cheaper courier stays
 *  honest for наложен-платеж rows. Used by the import editor to auto-pick the cheaper
 *  courier per row. */
export const compareShipment = async (
  input: { destinationCity: string; deliveryMode: 'office' | 'address'; weightGrams?: number; codAmountStotinki?: number },
): Promise<QuoteResult> =>
  (await bff('shipping/compare', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
  }, 'Сравнението се провали')).json();

export interface AddressPrediction { description: string; placeId: string; }

/** Google Places autocomplete proxied by the API (key stays server-side). */
export const addressSuggest = async (query: string, sessionToken: string): Promise<AddressPrediction[]> =>
  (await bff('shipping/address-suggest', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, sessionToken }),
  }, 'Грешка при предложенията')).json();
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
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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
  /** Source order id — the path param for finalizing a courier draft into a waybill.
   *  Set only for order-backed Econt rows; null for order-less manual rows (where the
   *  backend overloads `orderId` as a row key, not a navigable order id). */
  orderId?: string | null;
  /** Human order reference, shown next to the receiver on draft rows. */
  orderNumber?: string | null;
  receiver: string;
  method: string | null;
  status: ShipmentStatus;
  trackingNumber?: string | null;
  priceStotinki?: number | null;
  codAmountStotinki?: number | null;
  labelPdfUrl?: string | null;
  /** Set once a courier pickup has been requested for this waybill — drives the
   *  „Куриер заявен" pill and keeps the row out of a second pickup request. */
  courierRequestStatus?: string | null;
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
  courierRequestStatus?: string | null;
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
  courierRequestStatus?: string | null;
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
    // For a manual (order-less) row the backend overloads `orderId` as a row key, so
    // never treat it as a finalizable order id — only real courier orders get one.
    orderId: r.manual ? null : r.orderId,
    orderNumber: r.manual ? null : r.orderNumber,
    receiver: r.customerName,
    method: econtMethodLabel(r.method),
    status: r.status,
    trackingNumber: r.trackingNumber ?? null,
    priceStotinki: r.priceStotinki ?? null,
    codAmountStotinki: r.codAmountStotinki ?? null,
    labelPdfUrl: r.labelPdfUrl ?? null,
    courierRequestStatus: r.courierRequestStatus ?? null,
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
    courierRequestStatus: r.courierRequestStatus ?? null,
  }));
};

const carrierBase = (c: Carrier) => (c === 'speedy' ? 'speedy' : 'shipping');

/** The carrier's public tracking page for a waybill number — same link the buyer gets
 *  in the „пратката тръгна" email, so the farmer can follow a parcel from the table too. */
export const carrierTrackUrl = (carrier: Carrier, number: string): string => {
  const n = number.replace(/\s/g, '');
  return carrier === 'speedy'
    ? `https://www.speedy.bg/bg/track-shipment?shipmentNumber=${n}`
    : `https://www.econt.com/services/track-shipment/${n}/`;
};

/** Finalize a courier DRAFT (an order with no waybill yet) into a real waybill with the
 *  farmer's chosen carrier. Routes to that carrier's order-label endpoint:
 *   - econt  → POST shipping/orders/:orderId/label
 *   - speedy → POST speedy/orders/:orderId/label
 *  Both are farmer-scoped on the dostavki backend (createLabelForOrder(t, orderId, f)). */
/** Per-shipment overrides the farmer can set on a draft before it becomes a waybill.
 *  All optional — anything omitted falls back to the farm's package defaults. */
export interface DraftOverrides {
  /** Real parcel weight in kg (drives the courier price). */
  weightKg?: number;
  /** What's inside — printed on the waybill. */
  contents?: string;
  /** Number of separate boxes. */
  parcelCount?: number;
  /** Insured value in stotinki (EUR cents); omit/0 = no insurance. */
  declaredValueStotinki?: number;
  /** „Обратна разписка" — signed delivery receipt back to the sender (Speedy only). */
  returnReceipt?: boolean;
}

export const finalizeCourierDraft = async (
  carrier: Carrier,
  orderId: string,
  overrides?: DraftOverrides,
): Promise<void> => {
  await bff(`${carrierBase(carrier)}/orders/${orderId}/label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(overrides ?? {}),
  }, 'Създаването на товарителница се провали');
};

export const refreshShipment = async (carrier: Carrier, id: string): Promise<void> => {
  await bff(`${carrierBase(carrier)}/shipments/${id}/refresh`, { method: 'POST' }, 'Опресняването се провали');
};

export const downloadLabel = async (carrier: Carrier, id: string): Promise<void> => {
  const res = await bff(`${carrierBase(carrier)}/shipments/${id}/label.pdf`, undefined, 'Етикетът не може да се свали');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
};

/** Ask the carrier to send a courier to collect already-created waybills (a paid
 *  action — the backend gates Econt behind ActivationGuard). The pickup endpoints are
 *  per-carrier, so the caller groups its selection by carrier and calls once per carrier:
 *   - econt  → POST shipping/courier
 *   - speedy → POST speedy/courier
 *  Both accept `{ shipmentIds }` (our shipment UUIDs) and persist a courierRequestStatus. */
export const requestCourier = async (carrier: Carrier, shipmentIds: string[]): Promise<void> => {
  await bff(`${carrierBase(carrier)}/courier`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shipmentIds }),
  }, 'Заявката за куриер се провали');
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

export const riskCheck = async (phone: string, opts?: { refresh?: boolean }): Promise<RiskCheckResult> => {
  const url = `shipping/risk/check?phone=${encodeURIComponent(phone)}${opts?.refresh ? '&refresh=1' : ''}`;
  return (await bff(url, undefined, 'Проверката се провали')).json();
};

/** One entry per unique normalized phone returned by the bulk check endpoint. */
export interface RiskBulkEntry {
  phone: string;
  normalized: string;
  verdict: 'ok' | 'caution' | 'high';
  /** Status of this entry: a risk verdict for answered phones, or a non-answer state. */
  status: 'ok' | 'caution' | 'high' | 'rate_limited' | 'unavailable';
  strikes: number;
  nekorektenCount: number;
  cached: boolean;
  /** Seconds until the rate limit resets (present when status='rate_limited'). */
  retryAfterSeconds?: number;
}

export interface RiskBulkMeta {
  /** Number of phones that received a real verdict this run. */
  checked: number;
  /** Number of phones that were skipped due to rate limiting. */
  rateLimited: number;
  /** Which limit was hit, or null if none. */
  limit: 'minute' | 'day' | null;
  /** Seconds until the rate limit resets (0 when no limit hit). */
  retryAfterSeconds: number;
}

export interface RiskBulkResponse {
  results: RiskBulkEntry[];
  meta: RiskBulkMeta;
}

export const riskCheckBulk = async (phones: string[]): Promise<RiskBulkResponse> =>
  (await bff('shipping/risk/check-bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phones }),
  }, 'Масовата проверка се провали')).json();

export const riskCandidates = async (): Promise<RiskCandidate[]> =>
  (await bff('shipping/risk/candidates')).json();

export const riskReport = async (shipmentId: string): Promise<{ reported: true }> =>
  (await bff(`shipping/risk/reports/${shipmentId}`, { method: 'POST' }, 'Докладването се провали')).json();

/* ------------------------------- settings --------------------------------- */

export interface EcontSender {
  name?: string; phone?: string; cityId?: number; cityName?: string;
  mode?: 'office' | 'address'; officeCode?: string; address?: string;
}
export type EcontPickupPoint = EcontSender & { id: string; label: string };
/** Econt config blob (credentials stripped of the encrypted password). */
export interface EcontConfig {
  configured?: boolean;
  env?: 'demo' | 'prod';
  /** Account-derived (super-admin demo flag); the operator can't change it. */
  isDemo?: boolean;
  username?: string;
  sender?: EcontSender;
  senders?: EcontPickupPoint[];
  activeSenderId?: string | null;
  defaultPackage?: { weightKg?: number; contents?: string; dimensions?: string };
  cod?: { enabled?: boolean; feePayer?: 'customer' | 'farm' };
  label?: { paper?: 'A4' | 'A6'; autoCreate?: boolean };
  [k: string]: unknown;
}
export interface SpeedySender {
  contactName?: string; phone?: string; mode?: 'office' | 'address';
  officeId?: number; siteId?: number; siteName?: string; streetId?: number; streetNo?: string;
}
export type SpeedyPickupPoint = SpeedySender & { id: string; label: string };
/** Speedy config blob (credentials stripped of the encrypted password). */
export interface SpeedyConfig {
  configured?: boolean;
  env?: 'demo' | 'prod';
  /** Account-derived (super-admin demo flag); the operator can't change it. */
  isDemo?: boolean;
  userName?: string;
  clientSystemId?: number;
  defaultServiceId?: number;
  sender?: SpeedySender;
  senders?: SpeedyPickupPoint[];
  activeSenderId?: string | null;
  defaultPackage?: { parcelsCount?: number; weightKg?: number; contents?: string };
  cod?: { enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' };
  label?: { autoCreate?: boolean };
  [k: string]: unknown;
}

/** Live nomenclature rows for the sender pickers. */
export interface EcontCity { id: number; name: string; postCode: string | null; }
export interface EcontOfficeLive { code: string; name: string; city: string | null; address: string | null; }
export interface SpeedySite { id: number; name: string; postCode: string | null; }
export interface SpeedyOffice { id: number; name: string; address: string | null; }

export const listEcontCities = async (q?: string): Promise<EcontCity[]> =>
  (await bff(`shipping/cities${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json();
export const listEcontOffices = async (cityId: number): Promise<EcontOfficeLive[]> =>
  (await bff(`shipping/offices?cityId=${cityId}`)).json();
export const listSpeedySites = async (q?: string): Promise<SpeedySite[]> =>
  (await bff(`speedy/sites${q ? `?q=${encodeURIComponent(q)}` : ''}`)).json();
export const listSpeedyOffices = async (siteId: number): Promise<SpeedyOffice[]> =>
  (await bff(`speedy/offices?siteId=${siteId}`)).json();

/** Save the Econt sender/package/COD profile (credentials are saved separately). */
export const saveEcontProfile = async (body: {
  sender?: EcontSender;
  defaultPackage?: { weightKg?: number; contents?: string };
  cod?: { enabled?: boolean; feePayer?: 'customer' | 'farm' };
}): Promise<{ ok: true }> =>
  (await bff('shipping/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'Запазването се провали')).json();

/** Save the Speedy sender/package/COD profile. */
export const saveSpeedyProfile = async (body: {
  sender?: SpeedySender;
  defaultPackage?: { parcelsCount?: number; weightKg?: number; contents?: string };
  cod?: { enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' };
}): Promise<{ ok: true }> =>
  (await bff('speedy/profile', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'Запазването се провали')).json();

/** Save the Econt pickup-point book + which point is active. */
export const saveEcontSenders = async (body: { senders: EcontPickupPoint[]; activeId: string }): Promise<{ ok: true }> =>
  (await bff('shipping/senders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'Запазването се провали')).json();

/** Save the Speedy pickup-point book + which point is active. */
export const saveSpeedySenders = async (body: { senders: SpeedyPickupPoint[]; activeId: string }): Promise<{ ok: true }> =>
  (await bff('speedy/senders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 'Запазването се провали')).json();

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

export const disconnectEcont = async (): Promise<{ configured: false }> =>
  (await bff('shipping/credentials', { method: 'DELETE' }, 'Премахването се провали')).json();

export const disconnectSpeedy = async (): Promise<{ configured: false }> =>
  (await bff('speedy/credentials', { method: 'DELETE' }, 'Премахването се провали')).json();
