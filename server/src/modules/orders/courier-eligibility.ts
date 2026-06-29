/**
 * Courier-per-farmer eligibility (Phase 2). A farmer's carrier credentials live
 * in the tenant's settings JSONB under `delivery.farmers[<farmerId>]`, mirroring
 * the tenant-level `delivery.{econt,speedy}` shape, each with a `configured` flag.
 * Pure helpers — used both by the public storefront (to show the Куриер option)
 * and by the checkout backstop (to reject a courier order for an unready farmer).
 */

/** A farmer's carrier sub-namespace inside `tenants.settings.delivery.farmers[id]`. */
export interface FarmerDeliveryNamespace {
  econt?: { configured?: boolean };
  speedy?: { configured?: boolean };
}

interface SettingsWithFarmers {
  delivery?: { farmers?: Record<string, FarmerDeliveryNamespace> };
}

/** Read a farmer's delivery sub-namespace from the tenant `settings` JSONB. */
export function farmerDeliveryNamespace(
  settings: unknown,
  farmerId: string,
): FarmerDeliveryNamespace | undefined {
  return (settings as SettingsWithFarmers | null)?.delivery?.farmers?.[farmerId];
}

/**
 * Whether a farmer can actually ship via courier: Vasil enabled it
 * (`courier_enabled`) AND the farmer has at least one carrier (Econt or Speedy)
 * connected in their sub-namespace.
 */
export function farmerCourierReady(
  courierEnabled: boolean,
  ns: FarmerDeliveryNamespace | undefined,
): boolean {
  if (!courierEnabled) return false;
  return !!(ns?.econt?.configured || ns?.speedy?.configured);
}
