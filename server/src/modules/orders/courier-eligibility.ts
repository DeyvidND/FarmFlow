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
 * Whether a farmer can ship via courier: they have at least one carrier
 * (Econt or Speedy) connected in their sub-namespace. There is no separate
 * per-farmer opt-in — connecting a carrier is the switch.
 */
export function farmerCourierReady(ns: FarmerDeliveryNamespace | undefined): boolean {
  return !!(ns?.econt?.configured || ns?.speedy?.configured);
}
