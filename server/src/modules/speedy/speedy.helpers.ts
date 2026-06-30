/** Canonical shipment status shared with Econt's vocabulary so the COD-risk hook,
 *  reconciliation and list views work the same for both carriers. 'returned' and
 *  'refused' are recognized by cod-risk's isReturnedStatus ('return'/'refus' substrings). */
export type CanonicalStatus =
  | 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused';

/** Default Speedy courier-service code used for every shipment when the tenant set
 *  no explicit service. Farmers don't know Speedy service codes, so the UI omits the
 *  field and we ship on this one service across estimate AND label creation.
 *  Confirmed live (demo, 2026-06-30): service 505 = „СТАНДАРТ 24 ЧАСА" / STANDARD 24
 *  HOURS — the standard door/office parcel service (the route's other services are
 *  pallet/tyres, irrelevant to a farm parcel), so the single hardcoded default is
 *  correct and a service picker would add no farmer value. */
export const SPEEDY_DEFAULT_SERVICE_ID = 505;

/** stotinki (EUR cents) → a 2-decimal EUR number for the Speedy API. */
export function toEur(stotinki: number): number {
  return Math.round(stotinki) / 100;
}

/** Speedy's public tracking page for a parcel barcode. */
export function trackingUrl(barcode: string): string {
  return `https://www.speedy.bg/bg/track-shipment?shipmentNumber=${barcode.replace(/\s/g, '')}`;
}

/**
 * Collapse a Speedy /track operations[] history into a canonical status. Keyed off
 * the LATEST operation's free-text description (Bulgarian + English), mirroring the
 * keyword approach used for Econt. // spike: confirm operation codes vs live /track.
 */
export function parseTrackStatus(
  operations: Array<{ description?: string | null; code?: number | string | null }> | null | undefined,
  hasBarcode: boolean,
): CanonicalStatus {
  if (!hasBarcode) return 'pending';
  const ops = Array.isArray(operations) ? operations : [];
  const last = ops.length ? ops[ops.length - 1] : null;
  const d = (last?.description ?? '').toLowerCase();
  if (d.includes('върн') || d.includes('return')) return 'returned';
  if (d.includes('отказ') || d.includes('refus')) return 'refused';
  if (d.includes('достав') || d.includes('предадена') || d.includes('deliver')) return 'delivered';
  // In-transit tokens only. Do NOT match the bare stem 'товар' — it also matches
  // "товарителница" (waybill), so a "товарителница приета/създадена" op (just a waybill
  // accepted, no movement yet) would wrongly read as 'shipped'.
  if (
    d.includes('в транзит') || d.includes('транзит') || d.includes('натоварен') ||
    d.includes('на път') || d.includes('път') || d.includes('transit') || d.includes('ship')
  )
    return 'shipped';
  return 'created';
}

/** The stored Speedy config (sender profile + package defaults). */
export interface SpeedyStored {
  env?: 'demo' | 'prod';
  userName?: string;
  passwordEnc?: string;
  clientSystemId?: number;
  defaultServiceId?: number;
  configured?: boolean;
  sender?: {
    contactName?: string;
    phone?: string;
    mode?: string; // 'office' | 'address'; kept as string so plain object literals assign
    officeId?: number;
    siteId?: number;
    streetId?: number;
    streetNo?: string;
  };
  defaultPackage?: { parcelsCount?: number; weightKg?: number; contents?: string; packaging?: string };
  cod?: { enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' };
  // Print-time + auto-create toggle — mirrors Econt's label.autoCreate field.
  label?: { autoCreate?: boolean };
  [k: string]: unknown;
}

export interface ManualInput {
  receiverName: string;
  receiverPhone: string;
  deliveryMode: 'office' | 'address';
  officeId?: number;
  siteId?: number;
  streetId?: number;
  streetNo?: string;
  blockNo?: string;
  entranceNo?: string;
  floorNo?: string;
  apartmentNo?: string;
  serviceId: number;
  weightGrams?: number;
  parcelsCount?: number;
  contents?: string;
  packaging?: string;
  codAmountStotinki?: number;
  declaredValueStotinki?: number;
  codProcessingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER';
  /** Free-text street/details for a door address WITHOUT a resolved streetId — goes into
   *  Speedy's `address.addressNote` („Уточнение"). REQUIRED for a storefront door order,
   *  whose address is a hand-typed string, else Speedy rejects with `details_required`. */
  addressNote?: string;
  /** „Обратна разписка" — a signed delivery receipt is returned to the sender. */
  returnReceipt?: boolean;
}

/**
 * Build the Speedy POST /shipment body from the farm's sender profile + hand-entered
 * receiver. Field shapes verified live against api.speedy.bg/v1:
 *  - Office delivery uses `recipient.pickupOfficeId` with NO `recipient.address` — a
 *    present address is validated as a DOOR address and rejected (`details_required`).
 *  - Door delivery uses the id-based `recipient.address` (siteId/streetId/streetNo), OR
 *    just `siteId` + free-text `addressNote` when no streetId is resolved (storefront
 *    orders) — a streetless address with neither is rejected (`details_required`).
 *  - `content.package` (packaging type) is REQUIRED — create fails 605 without it.
 *  - COD + declared value ride on `service.additionalServices` in EUR.
 */
export function buildShipmentRequest(cfg: SpeedyStored, input: ManualInput): Record<string, unknown> {
  const sender = cfg.sender ?? {};
  const pkg = cfg.defaultPackage ?? {};
  const contents = input.contents || pkg.contents || 'Хранителни продукти';
  const weightKg = input.weightGrams ? input.weightGrams / 1000 : (pkg.weightKg ?? 1);
  const parcelsCount = input.parcelsCount ?? pkg.parcelsCount ?? 1;
  // Speedy requires a packaging type on create (content.package); default to a box.
  const packaging = input.packaging || pkg.packaging || 'BOX';

  const additionalServices: Record<string, unknown> = {};
  if (input.codAmountStotinki && input.codAmountStotinki > 0) {
    additionalServices.cod = {
      amount: toEur(input.codAmountStotinki),
      // Per-shipment override (e.g. batch setting) wins over the tenant default.
      processingType: input.codProcessingType ?? cfg.cod?.processingType ?? 'CASH',
      currencyCode: 'EUR',
    };
  }
  if (input.declaredValueStotinki && input.declaredValueStotinki > 0) {
    additionalServices.declaredValue = { amount: toEur(input.declaredValueStotinki) };
  }
  // „Обратна разписка" — verified live (demo, 2026-06-30) as a plain boolean flag.
  if (input.returnReceipt) additionalServices.returnReceipt = true;

  const service: Record<string, unknown> = { serviceId: input.serviceId, autoAdjustPickupDate: true };
  if (Object.keys(additionalServices).length) service.additionalServices = additionalServices;

  const senderBlock: Record<string, unknown> = {
    phone1: { number: sender.phone ?? '' },
    contactName: sender.contactName ?? 'Подател',
  };
  if (sender.mode === 'office' && sender.officeId) senderBlock.dropoffOfficeId = sender.officeId;

  const recipient: Record<string, unknown> = {
    phone1: { number: input.receiverPhone },
    clientName: input.receiverName,
    privatePerson: true,
  };
  if (input.deliveryMode === 'office') {
    recipient.pickupOfficeId = input.officeId;
  } else {
    recipient.address = {
      countryId: 100,
      siteId: input.siteId,
      ...(input.streetId ? { streetId: input.streetId } : {}),
      ...(input.streetNo ? { streetNo: input.streetNo } : {}),
      ...(input.blockNo ? { blockNo: input.blockNo } : {}),
      ...(input.entranceNo ? { entranceNo: input.entranceNo } : {}),
      ...(input.floorNo ? { floorNo: input.floorNo } : {}),
      ...(input.apartmentNo ? { apartmentNo: input.apartmentNo } : {}),
      // Free-typed street (storefront orders have no resolved streetId): Speedy accepts
      // the whole address in „Уточнение" (addressNote) — verified live, else it rejects
      // a streetless door address with `details_required`.
      ...(input.addressNote ? { addressNote: input.addressNote } : {}),
    };
  }

  return {
    sender: senderBlock,
    recipient,
    service,
    content: { parcelsCount, totalWeight: weightKg, contents, package: packaging },
    // Default: recipient pays courier (COD use-case). Verified enum 'RECIPIENT'.
    payment: { courierServicePayer: 'RECIPIENT' },
    ref1: contents.slice(0, 30),
  };
}

/**
 * Build the Speedy POST /calculate body. The pricing endpoint has a DIFFERENT shape
 * than /shipment (verified live): the service rides in `service.serviceIds` (an ARRAY)
 * and the destination in `recipient.addressLocation` — NOT `recipient.address`. Reusing
 * the /shipment body here returns `calculation.recipient.address.required` (no price).
 */
export function buildCalculateRequest(
  cfg: SpeedyStored,
  input: { siteId: number; serviceId: number; weightGrams?: number; codAmountStotinki?: number },
): Record<string, unknown> {
  const pkg = cfg.defaultPackage ?? {};
  const weightKg = input.weightGrams ? input.weightGrams / 1000 : (pkg.weightKg ?? 1);
  const parcelsCount = pkg.parcelsCount ?? 1;

  const service: Record<string, unknown> = { autoAdjustPickupDate: true, serviceIds: [input.serviceId] };
  if (input.codAmountStotinki && input.codAmountStotinki > 0) {
    service.additionalServices = {
      cod: {
        amount: toEur(input.codAmountStotinki),
        processingType: cfg.cod?.processingType ?? 'CASH',
        currencyCode: 'EUR',
      },
    };
  }

  return {
    recipient: { privatePerson: true, addressLocation: { siteId: input.siteId } },
    service,
    content: { parcelsCount, totalWeight: weightKg },
    payment: { courierServicePayer: 'RECIPIENT' },
  };
}

/** Read the first calculation's total price (EUR) from a live /calculate response.
 *  Real shape: `{ calculations: [{ price: { total, amount, currency } }] }` — there is
 *  NO top-level `price`. Returns null when no calculation/price is present. */
export function parseCalculatePrice(res: unknown): number | null {
  const r = (res ?? {}) as Record<string, any>;
  const calcs: any[] = Array.isArray(r.calculations) ? r.calculations : [];
  if (!calcs.length) return null;
  const price = (calcs[0]?.price ?? {}) as Record<string, any>;
  const total = price.total ?? price.amount;
  return Number.isFinite(total) ? Number(total) : null;
}

export interface SpeedyPayout {
  barcode: string | null;
  amountStotinki: number;
  settledAt: string | null;
}

/** Read Speedy's /payments PayoutResponse defensively into reconciliation rows. */
export function parsePayouts(res: unknown): SpeedyPayout[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.payouts) ? r.payouts : Array.isArray(r.data) ? r.data : [];
  return list.map((p) => ({
    barcode: p?.shipmentBarcode ?? p?.barcode ?? null,
    amountStotinki: Math.round(Number(p?.amount ?? 0) * 100),
    settledAt: p?.paidDate ?? p?.date ?? null,
  }));
}

export interface SpeedySite { id: number; name: string; postCode: string | null; }
export interface SpeedyOffice { id: number; name: string; address: string | null; }
export interface SpeedyStreet { id: number; name: string; }
export interface SenderSuggestion { name: string; phone: string; clientNumber: string | null; }

export function slimSites(res: unknown): SpeedySite[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.sites) ? r.sites : [];
  return list
    .map((s) => ({ id: Number(s?.id), name: String(s?.name ?? '').trim(), postCode: s?.postCode ?? null }))
    .filter((s) => Number.isFinite(s.id) && s.name);
}

export function slimOffices(res: unknown): SpeedyOffice[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.offices) ? r.offices : [];
  return list
    .map((o) => {
      // Speedy may return `address` as a string OR a structured object; only keep a
      // string (a bare object would render as "[object Object]" in the picker).
      const addr = o?.address?.fullAddress ?? o?.address ?? null;
      return {
        id: Number(o?.id),
        name: String(o?.name ?? '').trim(),
        address: typeof addr === 'string' && addr.trim() ? addr : null,
      };
    })
    .filter((o) => Number.isFinite(o.id) && o.name);
}

export function slimStreets(res: unknown): SpeedyStreet[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.streets) ? r.streets : [];
  return list
    .map((s) => ({ id: Number(s?.id), name: String(s?.name ?? '').trim() }))
    .filter((s) => Number.isFinite(s.id) && s.name);
}

export function slimContractClients(res: unknown): SenderSuggestion[] {
  const r = (res ?? {}) as Record<string, any>;
  const list: any[] = Array.isArray(r) ? r : Array.isArray(r.clients) ? r.clients : [];
  return list.map((c) => {
    const phones: any[] = Array.isArray(c?.phones) ? c.phones : [];
    const phone = phones.length ? String(phones[0]?.number ?? phones[0] ?? '') : '';
    return {
      name: String(c?.clientName ?? c?.name ?? '').trim(),
      phone,
      clientNumber: c?.id != null ? String(c.id) : null,
    };
  });
}

/**
 * Map a storefront order (door delivery) + a resolved Speedy siteId → ManualInput
 * ready to pass to buildShipmentRequest / createManualShipment.
 *
 * COD is collected only on an unpaid наложен-платеж order — mirrors Econt's gate:
 *   paymentMethod === 'cod' && !paidAt && totalStotinki > 0
 */
export function buildOrderShipmentInput(
  cfg: SpeedyStored,
  order: {
    customerName: string | null;
    customerPhone: string | null;
    deliveryAddress: string | null;
    /** Block/entrance/floor/flat hint (бл./вх./ет./ап.) — appended to the address note. */
    deliveryNote?: string | null;
    paymentMethod?: 'online' | 'cod' | null;
    paidAt?: Date | null;
    totalStotinki?: number | null;
  },
  siteId: number,
  // Per-shipment overrides the farmer sets at finalize time; each falls back to the
  // farm's package defaults when absent.
  overrides?: { weightKg?: number; contents?: string; parcelCount?: number; declaredValueStotinki?: number; returnReceipt?: boolean },
): ManualInput {
  const collectCod =
    order.paymentMethod === 'cod' && !order.paidAt && !!order.totalStotinki;
  const weightKg = overrides?.weightKg ?? cfg.defaultPackage?.weightKg ?? 1;
  // The free-typed door address goes into Speedy's „Уточнение" — street + the bl./вх. hint.
  const addressNote = [order.deliveryAddress, order.deliveryNote].map((s) => s?.trim()).filter(Boolean).join(', ');

  return {
    receiverName: order.customerName ?? '—',
    receiverPhone: order.customerPhone ?? '—',
    deliveryMode: 'address',
    siteId,
    serviceId: cfg.defaultServiceId ?? SPEEDY_DEFAULT_SERVICE_ID,
    weightGrams: Math.round(weightKg * 1000),
    contents: overrides?.contents ?? cfg.defaultPackage?.contents,
    ...(addressNote ? { addressNote } : {}),
    ...(overrides?.parcelCount ? { parcelsCount: overrides.parcelCount } : {}),
    ...(overrides?.returnReceipt ? { returnReceipt: true } : {}),
    ...(overrides?.declaredValueStotinki && overrides.declaredValueStotinki > 0
      ? { declaredValueStotinki: overrides.declaredValueStotinki }
      : {}),
    ...(collectCod ? { codAmountStotinki: order.totalStotinki! } : {}),
  };
}
