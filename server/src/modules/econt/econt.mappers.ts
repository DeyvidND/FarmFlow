/**
 * Pure Econt row mappers / response parsers — no DB, no HTTP, no `this`. Extracted
 * from EcontService (the admin shipment-table shapes, tracking/COD/address parsing,
 * the manual-order + courier-request builders, and PDF merge). EcontService imports
 * these back and stays the orchestrator. Mirrors econt.label.ts / econt.sender.ts.
 */
import { PDFDocument } from 'pdf-lib';
import { type EcontStored, type InspectMode } from './econt.label';

export interface CodReconRow {
  orderId: string;
  expectedStotinki: number | null;
  collectedAt: string | null;
  settledAt: string | null;
}

/** Raw joined row from listShipments' query. */
export interface ShipmentJoinRow {
  orderId: string;
  customerName: string | null;
  deliveryType: string | null;
  total: number | null;
  shipmentId: string | null;
  shipmentNumber: string | null;
  shipmentStatus: string | null;
  courierPrice: number | null;
  labelPdfUrl: string | null;
  codAmount: number | null;
  trackingJson: unknown;
  /** Carrier recorded on the shipments row (set for Speedy; null for legacy Econt rows). */
  carrier: string | null;
  /** Carrier recorded on the order (the customer's choice at checkout). */
  orderCarrier: string | null;
  /** Speedy barcode / Econt-fallback tracking number from the shipments row. */
  trackingNumber: string | null;
  /** Speedy internal shipment id (carrierShipmentId column). */
  carrierShipmentId: string | null;
  /** Courier-pickup request status persisted on the shipments row (null until requested). */
  courierRequestStatus?: string | null;
}

/** Admin shipments-table row. */
export interface AdminShipment {
  orderId: string;
  orderNumber: string;
  customerName: string;
  method: 'econtOffice' | 'econtAddress';
  status: 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused';
  /** Which carrier owns this shipment — used by the panel to route print/void/refresh. */
  carrier: 'econt' | 'speedy';
  trackingNumber?: string;
  priceStotinki?: number;
  codAmountStotinki?: number;
  labelPdfUrl?: string;
  shipmentId?: string;
  /** Set once a courier pickup has been requested for this waybill (e.g. 'process').
   *  Drives the „Куриер заявен" pill + excludes the row from re-requesting. */
  courierRequestStatus?: string | null;
  // True for order-less standalone shipments. For those, `orderId` carries the
  // shipment id as a row key (there is no order) — consumers must NOT use it as a
  // navigable order id when `manual` is set.
  manual?: boolean;
  history: { at: string; label: string; location?: string }[];
}

/** Merge label PDFs into one document. Unreadable buffers are skipped (a single
 *  bad label must not fail the whole bulk print). */
export async function mergePdfs(buffers: Buffer[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  for (const buf of buffers) {
    try {
      const doc = await PDFDocument.load(buf);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach((p) => merged.addPage(p));
    } catch {
      // skip a corrupt / non-PDF buffer
    }
  }
  return Buffer.from(await merged.save());
}

/** Raw manual-shipment row (no order join). */
export interface ManualShipmentRow {
  shipmentId: string;
  orderId: string | null;
  receiverName: string | null;
  deliveryMode: string | null;
  shipmentNumber: string | null;
  shipmentStatus: string | null;
  courierPrice: number | null;
  labelPdfUrl: string | null;
  codAmount: number | null;
  trackingJson: unknown;
  /** Carrier recorded on the shipments row (set for Speedy; null for legacy Econt rows). */
  carrier: string | null;
  /** Speedy barcode / tracking number from the shipments row. */
  trackingNumber: string | null;
  /** Speedy internal shipment id (carrierShipmentId column). */
  carrierShipmentId: string | null;
  /** Courier-pickup request status persisted on the shipments row (null until requested). */
  courierRequestStatus?: string | null;
}

/** Map a stored order-less shipment onto the admin shipments-table shape. */
export function mapManualShipmentRow(r: ManualShipmentRow): AdminShipment {
  // econtShipmentNumber for Econt rows; trackingNumber (Speedy barcode) for Speedy rows.
  const ref = r.shipmentNumber ?? r.trackingNumber ?? null;
  return {
    orderId: r.shipmentId, // no order — use the shipment id as the row key
    orderNumber: 'Ръчна',
    customerName: r.receiverName ?? '—',
    method: r.deliveryMode === 'address' ? 'econtAddress' : 'econtOffice',
    carrier: (r.carrier ?? 'econt') as 'econt' | 'speedy',
    status: uiShipmentStatus(ref, r.shipmentStatus),
    trackingNumber: ref ?? undefined,
    priceStotinki: r.courierPrice ?? undefined,
    codAmountStotinki: r.codAmount ?? undefined,
    labelPdfUrl: r.labelPdfUrl ?? undefined,
    shipmentId: r.shipmentId,
    courierRequestStatus: r.courierRequestStatus ?? null,
    manual: true,
    history: mapTrackingEvents(r.trackingJson),
  };
}

/** Map a joined query row onto the admin shipments-table shape. */
export function mapShipmentRow(r: ShipmentJoinRow): AdminShipment {
  // econtShipmentNumber for Econt rows; trackingNumber (Speedy barcode) for Speedy rows.
  const ref = r.shipmentNumber ?? r.trackingNumber ?? null;
  return {
    orderId: r.orderId,
    orderNumber: r.orderId.slice(0, 8),
    customerName: r.customerName ?? '—',
    // Courier IS door delivery, so it maps to the address method on every path.
    method: (r.deliveryType === 'econt_address' || r.deliveryType === 'courier') ? 'econtAddress' : 'econtOffice',
    carrier: (r.carrier ?? r.orderCarrier ?? 'econt') as 'econt' | 'speedy',
    status: uiShipmentStatus(ref, r.shipmentStatus),
    trackingNumber: ref ?? undefined,
    priceStotinki: r.courierPrice ?? r.total ?? undefined,
    codAmountStotinki: r.codAmount ?? undefined,
    labelPdfUrl: r.labelPdfUrl ?? undefined,
    shipmentId: r.shipmentId ?? undefined,
    courierRequestStatus: r.courierRequestStatus ?? null,
    history: mapTrackingEvents(r.trackingJson),
  };
}

/** The order-like shape `buildLabel` consumes, plus the optional service flags. */
export interface ManualOrderShape {
  customerName: string;
  customerPhone: string;
  deliveryType: 'econt' | 'econt_address';
  econtOffice: string | null;
  deliveryCity: string | null;
  deliveryAddress: string | null;
  totalStotinki: number | null;
  paymentMethod: 'cod' | 'online';
  paidAt: null;
  weightKg?: number;
  contents?: string;
  smsNotification?: boolean;
  refrigerated?: boolean;
  declaredValueStotinki?: number;
  inspectBeforePay?: InspectMode;
}

/** Turn hand-entered receiver input into the order-like shape buildLabel needs.
 *  COD is "the producer entered a COD amount"; weight is grams → kg. */
export function buildManualOrderShape(input: {
  receiverName: string;
  receiverPhone: string;
  deliveryMode: 'office' | 'address';
  receiverOfficeCode?: string;
  receiverCity?: string;
  receiverAddress?: string;
  weightGrams?: number;
  contents?: string;
  codAmountStotinki?: number;
  smsNotification?: boolean;
  refrigerated?: boolean;
  declaredValueStotinki?: number;
  inspectBeforePay?: InspectMode;
}): ManualOrderShape {
  const hasCod = !!input.codAmountStotinki && input.codAmountStotinki > 0;
  return {
    customerName: input.receiverName,
    customerPhone: input.receiverPhone,
    deliveryType: input.deliveryMode === 'address' ? 'econt_address' : 'econt',
    econtOffice: input.deliveryMode === 'office' ? (input.receiverOfficeCode ?? null) : null,
    deliveryCity: input.deliveryMode === 'address' ? (input.receiverCity ?? null) : null,
    deliveryAddress: input.deliveryMode === 'address' ? (input.receiverAddress ?? null) : null,
    totalStotinki: hasCod ? input.codAmountStotinki! : null,
    paymentMethod: hasCod ? 'cod' : 'online',
    paidAt: null,
    ...(input.weightGrams ? { weightKg: input.weightGrams / 1000 } : {}),
    ...(input.contents ? { contents: input.contents } : {}),
    ...(input.smsNotification ? { smsNotification: true } : {}),
    ...(input.refrigerated ? { refrigerated: true } : {}),
    ...(input.declaredValueStotinki ? { declaredValueStotinki: input.declaredValueStotinki } : {}),
    ...(input.inspectBeforePay && input.inspectBeforePay !== 'off'
      ? { inspectBeforePay: input.inspectBeforePay }
      : {}),
  };
}

export interface TrackingEvent {
  at: string;
  label: string;
  location?: string;
}

/** Normalize an Econt tracking time (epoch-ms number or ISO/HH:mm string). */
function trackTime(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0) return new Date(v).toISOString();
  if (typeof v === 'string' && v.length >= 5) return v;
  return '';
}

/** Map an Econt status payload's tracking history into UI events (newest last). */
export function mapTrackingEvents(status: unknown): TrackingEvent[] {
  const s = (status ?? {}) as Record<string, any>;
  const raw: any[] = Array.isArray(s.trackingEvents)
    ? s.trackingEvents
    : Array.isArray(s.tracking)
      ? s.tracking
      : [];
  return raw
    .map((e) => ({
      at: trackTime(e?.time ?? e?.cdDate ?? e?.date),
      // Econt's ShipmentTrackingEvent carries a human-readable Bulgarian narrative
      // (`destinationDetails`); `destinationType` is a raw enum (office/client/…),
      // so prefer the narrative and only fall back to the enum/office name.
      label: String(
        e?.destinationDetails ?? e?.destinationType ?? e?.officeName ?? e?.tracking ?? 'Обновление',
      ).trim(),
      location: e?.officeName
        ? String(e.officeName)
        : e?.cityName
          ? String(e.cityName)
          : undefined,
    }))
    .filter((e) => e.at || e.location);
}

/** Send the buyer the "shipped" email exactly once — when the parcel first reaches
 *  shipped/delivered and we haven't notified before. */
export function shouldNotifyShipped(
  uiStatus: 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused',
  customerNotifiedAt: Date | string | null,
): boolean {
  return !customerNotifiedAt && (uiStatus === 'shipped' || uiStatus === 'delivered');
}

/**
 * Extract COD reconciliation timestamps from an Econt status payload.
 * Field names confirmed from Econt's ShipmentStatus model:
 *   cdCollectedTime — COD collected from the recipient
 *   cdPaidTime      — COD paid/settled to the sender (farm)
 * The JSON API returns these as unix timestamps (seconds or ms) or ISO strings.
 */
export function parseCodReconciliation(status: unknown): { collectedAt: Date | null; settledAt: Date | null } {
  const s = (status ?? {}) as Record<string, any>;
  const toDate = (v: unknown): Date | null => {
    if (typeof v === 'number' && v > 0) {
      // seconds (~10 digits) vs ms (~13 digits): scale seconds up to ms.
      const ms = v < 1e12 ? v * 1000 : v;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === 'string' && v.length >= 5) {
      const d = new Date(v);
      return Number.isNaN(d.getTime()) ? null : d;
    }
    return null;
  };
  return { collectedAt: toDate(s.cdCollectedTime), settledAt: toDate(s.cdPaidTime) };
}

export interface AddressValidation {
  valid: boolean;
  status: string | null;
}

/** Interpret Econt's `validateAddress` response. `normal`/`processed` = usable;
 *  anything else (incl. a shapeless/empty response) = not deliverable. */
export function parseAddressValidation(res: unknown): AddressValidation {
  const r = (res ?? {}) as Record<string, any>;
  const status: string | null = typeof r.validationStatus === 'string' ? r.validationStatus : null;
  return { valid: status === 'normal' || status === 'processed', status };
}

export interface SenderSuggestion {
  name: string;
  phone: string;
  clientNumber: string | null;
}

/** Slim Econt client profiles into sender suggestions. Econt nests the data under
 *  `profiles[].client` in current docs, but some responses are flat — handle both. */
export function slimClientProfiles(res: unknown): SenderSuggestion[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r.profiles) ? r.profiles : [];
  return list.map((p) => {
    const c = p?.client ?? p ?? {};
    const phones: any[] = Array.isArray(c.phones) ? c.phones : [];
    return {
      name: String(c.name ?? '').trim(),
      phone: phones.length ? String(phones[0]) : '',
      clientNumber: c.clientNumber != null ? String(c.clientNumber) : null,
    };
  });
}

/** Build the Econt `requestCourier` payload from the farm's sender profile +
 *  already-created waybill numbers. `shipmentType` casing is verified in the spike
 *  (docs say lowercase `pack`; the PHP SDK sends `PACK`). */
export function buildCourierRequest(
  econt: EcontStored,
  shipmentNumbers: string[],
  window: { timeFrom?: string; timeTo?: string },
): Record<string, unknown> {
  const sender = (econt.sender ?? {}) as Record<string, any>;
  const body: Record<string, unknown> = {
    shipmentType: 'pack',
    shipmentPackCount: shipmentNumbers.length,
    senderClient: { name: sender.name || 'Подател', phones: [sender.phone || ''] },
    attachShipments: shipmentNumbers,
  };
  if (sender.mode === 'address') {
    body.senderAddress = { city: { name: sender.cityName ?? '' }, other: sender.address ?? '' };
  } else {
    if (sender.officeCode) body.senderOfficeCode = sender.officeCode;
  }
  if (window.timeFrom) body.requestTimeFrom = window.timeFrom;
  if (window.timeTo) body.requestTimeTo = window.timeTo;
  return body;
}

/** Collapse Econt's free-text status into the admin table's known status set.
 *  Returned/refused/cancelled parcels collapse to 'returned'/'refused' (matched by the
 *  same Bulgarian substrings as delivery-accounts.helpers.isDeadCodStatus) so they don't
 *  masquerade as delivered/shipped in the panel. */
export function uiShipmentStatus(
  number: string | null,
  status: string | null,
): 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused' {
  if (!number) return 'pending';
  const s = (status ?? '').toLowerCase();
  // Check terminal-failure states FIRST — a returned parcel may still carry a delivery word.
  if (s.includes('върн') || s.includes('return')) return 'returned';
  if (s.includes('отказ') || s.includes('анулир') || s.includes('refus') || s.includes('cancel')) return 'refused';
  if (s.includes('достав') || s.includes('deliver')) return 'delivered';
  if (s.includes('транзит') || s.includes('transit') || s.includes('ship')) return 'shipped';
  return 'created';
}
