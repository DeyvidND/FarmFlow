/** Canonical shipment status shared with Econt's vocabulary so the COD-risk hook,
 *  reconciliation and list views work the same for both carriers. 'returned' and
 *  'refused' are recognized by cod-risk's isReturnedStatus ('return'/'refus' substrings). */
export type CanonicalStatus =
  | 'pending' | 'created' | 'shipped' | 'delivered' | 'returned' | 'refused';

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
  defaultPackage?: { parcelsCount?: number; weightKg?: number; contents?: string };
  cod?: { enabled?: boolean; processingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER' };
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
  codAmountStotinki?: number;
  declaredValueStotinki?: number;
  codProcessingType?: 'CASH' | 'POSTAL_MONEY_TRANSFER';
}

/**
 * Build the Speedy POST /shipment body from the farm's sender profile + hand-entered
 * receiver. Addresses are id-based (siteId/streetId/streetNo for a door, officeId for
 * an office). COD + declared value ride on service.additionalServices in EUR.
 * // spike: verify sender/recipient/address field names + payer enums vs live API.
 */
export function buildShipmentRequest(cfg: SpeedyStored, input: ManualInput): Record<string, unknown> {
  const sender = cfg.sender ?? {};
  const pkg = cfg.defaultPackage ?? {};
  const contents = input.contents || pkg.contents || 'Хранителни продукти';
  const weightKg = input.weightGrams ? input.weightGrams / 1000 : (pkg.weightKg ?? 1);
  const parcelsCount = input.parcelsCount ?? pkg.parcelsCount ?? 1;

  const recipientAddress: Record<string, unknown> =
    input.deliveryMode === 'office'
      ? { countryId: 100, officeId: input.officeId }
      : {
          countryId: 100,
          siteId: input.siteId,
          ...(input.streetId ? { streetId: input.streetId } : {}),
          ...(input.streetNo ? { streetNo: input.streetNo } : {}),
          ...(input.blockNo ? { blockNo: input.blockNo } : {}),
          ...(input.entranceNo ? { entranceNo: input.entranceNo } : {}),
          ...(input.floorNo ? { floorNo: input.floorNo } : {}),
          ...(input.apartmentNo ? { apartmentNo: input.apartmentNo } : {}),
        };

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

  const service: Record<string, unknown> = { serviceId: input.serviceId, autoAdjustPickupDate: true };
  if (Object.keys(additionalServices).length) service.additionalServices = additionalServices;

  const senderBlock: Record<string, unknown> = {
    phone1: { number: sender.phone ?? '' },
    contactName: sender.contactName ?? 'Подател',
  };
  if (sender.mode === 'office' && sender.officeId) senderBlock.dropoffOfficeId = sender.officeId;

  return {
    sender: senderBlock,
    recipient: {
      phone1: { number: input.receiverPhone },
      clientName: input.receiverName,
      privatePerson: true,
      address: recipientAddress,
    },
    service,
    content: { parcelsCount, totalWeight: weightKg, contents },
    // Default: recipient pays courier (COD use-case). // spike: confirm payer enum.
    payment: { courierServicePayer: 'RECIPIENT' },
    ref1: contents.slice(0, 30),
  };
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
    paymentMethod?: 'online' | 'cod' | null;
    paidAt?: Date | null;
    totalStotinki?: number | null;
  },
  siteId: number,
): ManualInput {
  const collectCod =
    order.paymentMethod === 'cod' && !order.paidAt && !!order.totalStotinki;
  const weightKg = cfg.defaultPackage?.weightKg ?? 1;

  return {
    receiverName: order.customerName ?? '—',
    receiverPhone: order.customerPhone ?? '—',
    deliveryMode: 'address',
    siteId,
    serviceId: cfg.defaultServiceId ?? 0,
    weightGrams: Math.round(weightKg * 1000),
    contents: cfg.defaultPackage?.contents,
    ...(collectCod ? { codAmountStotinki: order.totalStotinki! } : {}),
  };
}
