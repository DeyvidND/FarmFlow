/**
 * Pure Econt label / shipment-payload logic — no DB, no HTTP, no `this`. Extracted
 * from EcontService so the (live-validated) payload shaping can be read and unit-
 * tested on its own. EcontService imports these back and stays the orchestrator.
 */

/** Weight bucket (kg) for estimate cache keys — see `bucketWeight`. */
export const WEIGHT_BUCKET_KG = 0.5;

/** The stored Econt delivery blob (settings.delivery.econt or a farmer's account). */
export interface EcontStored {
  env?: 'demo' | 'prod';
  username?: string;
  passwordEnc?: string;
  configured?: boolean;
  sender?: Record<string, unknown>;
  defaultPackage?: { weightKg?: number; contents?: string; dimensions?: string };
  cod?: { enabled?: boolean; feePayer?: 'customer' | 'farm' };
  // Print-time PDF format only (A4/A6); not a createLabel API field. `autoCreate`
  // makes a paid order auto-generate its waybill (see autoCreateForOrder).
  label?: { paper?: string; autoCreate?: boolean };
  nomenclature?: { lastSyncedAt?: string; cities?: number; offices?: number };
  [k: string]: unknown;
}

/** Parse a free-text "LxWxH" dimension string into three positive numbers (cm). */
export function parseDimensions(raw: unknown): { l: number; w: number; h: number } | null {
  if (typeof raw !== 'string') return null;
  const nums = raw
    .split(/[^\d.]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (nums.length < 3) return null;
  return { l: nums[0], w: nums[1], h: nums[2] };
}

export type InspectMode = 'off' | 'open' | 'test';

/**
 * Econt „преглед/тест преди плащане" → TOP-LEVEL ShippingLabel boolean fields
 * (NOT under `services`). Confirmed against the Econt model doc
 * (ee.econt.com/services/Shipments): `payAfterAccept` = „пратката може да се
 * прегледа преди плащане", `payAfterTest` = „може да се тества преди плащане".
 * Only meaningful on a COD shipment (the caller gates on collectCod). Ignored by
 * Econt for automat/post-station deliveries.
 */
export function econtInspectLabelFields(mode?: InspectMode | null): Record<string, unknown> | null {
  if (mode === 'open') return { payAfterAccept: true }; // отвори/прегледай преди плащане
  if (mode === 'test') return { payAfterTest: true };   // тествай преди плащане
  return null;
}

/** Read the carrier-agnostic handling policy off the tenant settings blob.
 *  Defensive: any missing/odd shape → everything off. */
export function resolveHandling(settings: unknown): { refrigerated: boolean; inspectBeforePay: InspectMode } {
  const s = (settings as Record<string, unknown> | null) ?? {};
  const delivery = (s.delivery as Record<string, unknown> | null) ?? {};
  const h = (delivery.handling as Record<string, unknown> | null) ?? {};
  const mode = h.inspectBeforePay;
  return {
    refrigerated: h.refrigerated === true,
    inspectBeforePay: mode === 'open' || mode === 'test' ? mode : 'off',
  };
}

/**
 * Build the Econt `label` payload from an order + the farm's sender profile.
 *
 * Shapes validated live against Econt's API (demo): `senderClient`/`receiverClient`
 * are `{name, phones[]}`; a legal-entity sender is REJECTED without `senderAgent`
 * (authorized person); the hand-in/drop-off points are `senderOfficeCode`/
 * `senderAddress` and `receiverOfficeCode`/`receiverAddress` at the label level.
 * A door address must be structured `{city:{name}, other:"street, №"}` — a bare
 * `fullAddress` errors `ExInvalidCity`. COD rides on `services.cdAmount`.
 */
export function buildLabel(
  econt: EcontStored,
  order: {
    customerName: string | null;
    customerPhone: string | null;
    deliveryType?: string | null;
    econtOffice: string | null;
    deliveryAddress?: string | null;
    deliveryCity?: string | null;
    totalStotinki?: number | null;
    paymentMethod?: string | null;
    paidAt?: Date | string | null;
    smsNotification?: boolean | null;
    refrigerated?: boolean | null;
    declaredValueStotinki?: number | null;
    inspectBeforePay?: InspectMode | null;
  },
  items: { name: string | null; qty: number }[],
  opts?: { packCount?: number | null },
): Record<string, unknown> {
  const sender = (econt.sender ?? {}) as Record<string, any>;
  const senderName: string = sender.name || 'Подател';
  const senderPhone: string = sender.phone || '';
  const pkg = econt.defaultPackage;
  const contents =
    pkg?.contents ||
    items.map((i) => `${i.name} x${i.qty}`).join(', ').slice(0, 100) ||
    'Хранителни продукти';

  const label: Record<string, unknown> = {
    senderClient: { name: senderName, phones: [senderPhone] },
    // Authorized person — mandatory for a legal entity, else Econt returns 517.
    senderAgent: { name: senderName, phones: [senderPhone] },
    receiverClient: {
      name: order.customerName ?? 'Клиент',
      phones: [order.customerPhone ?? ''],
    },
    // How many physical boxes the parcel is split into; farmer-set, default 1.
    packCount: opts?.packCount && opts.packCount > 0 ? Math.floor(opts.packCount) : 1,
    shipmentType: 'pack',
    weight: pkg?.weightKg ?? 1,
    shipmentDescription: contents,
  };

  // Where the parcel is handed in: a sender office, or the farm's own address.
  if (sender.mode === 'address') {
    label.senderAddress = { city: { name: sender.cityName ?? '' }, other: sender.address ?? '' };
  } else {
    label.senderOfficeCode = sender.officeCode ?? undefined;
  }

  // Where it goes: a receiver office, or the customer's door. A 'courier' order
  // (farmer-shipped, Phase 3) is ALWAYS door delivery → address branch.
  if (order.deliveryType === 'econt_address' || order.deliveryType === 'courier') {
    label.receiverAddress = {
      city: { name: order.deliveryCity ?? '' },
      other: order.deliveryAddress ?? '',
    };
  } else {
    label.receiverOfficeCode = order.econtOffice ?? undefined;
  }

  // Assemble optional label `services` (COD + SMS + refrigerated + declared value).
  // Emitted only when at least one service applies, so a plain shipment sends no
  // `services` key (keeps the Econt payload minimal + existing tests stable).
  const services: Record<string, unknown> = {};

  // Cash on delivery: collect the order total from the customer (app currency = EUR).
  // Keyed on the ORDER's own payment choice, never on an order already paid online,
  // so a paid Econt order can't be charged a second time at the door.
  const collectCod = order.paymentMethod === 'cod' && !order.paidAt;
  if (collectCod && order.totalStotinki) {
    services.cdAmount = Math.round(order.totalStotinki) / 100;
    services.cdType = 'get';
    services.cdCurrency = 'EUR';
    // Who covers the courier fee on a COD shipment (top-level fields).
    if (econt.cod?.feePayer === 'customer') {
      label.paymentReceiverMethod = 'cash';
    } else if (econt.cod?.feePayer === 'farm') {
      label.paymentSenderMethod = 'cash';
    }
  }

  // SMS to the receiver on the way / on delivery.
  if (order.smsNotification) services.smsNotification = true;
  // Refrigerated/perishable handling (Econt `refrigeratedPack` is an int count).
  if (order.refrigerated) services.refrigeratedPack = 1;
  // Преглед/тест преди плащане — top-level label fields, only on a COD parcel
  // (cuts refusals on food). payAfterAccept/payAfterTest live on the label, not services.
  if (collectCod) {
    const inspect = econtInspectLabelFields(order.inspectBeforePay);
    if (inspect) Object.assign(label, inspect);
  }
  // Declared value / insurance (обявена стойност), in EUR.
  if (order.declaredValueStotinki && order.declaredValueStotinki > 0) {
    services.declaredValueAmount = Math.round(order.declaredValueStotinki) / 100;
    services.declaredValueCurrency = 'EUR';
  }

  if (Object.keys(services).length) label.services = services;

  // Package dimensions in cm (top-level ShippingLabel fields). The farm stores
  // a free-text "LxWxH"; only send when it cleanly parses into three positive
  // numbers — partial/garbage dimensions make Econt reject the label.
  const dims = parseDimensions(econt.defaultPackage?.dimensions);
  if (dims) {
    label.shipmentDimensionsL = dims.l;
    label.shipmentDimensionsW = dims.w;
    label.shipmentDimensionsH = dims.h;
  }

  return label;
}

/**
 * Round a weight (kg) up to the nearest `WEIGHT_BUCKET_KG` bucket so nearby
 * basket weights share a single cache entry. E.g. 1.1kg → 1.5kg, 1.5kg → 1.5kg,
 * 1.6kg → 2.0kg with a 0.5kg bucket.
 */
export function bucketWeight(weightKg: number): number {
  return Math.ceil(weightKg / WEIGHT_BUCKET_KG) * WEIGHT_BUCKET_KG;
}
