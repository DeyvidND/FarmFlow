/** The resolved «Фермер на седмицата»: a farmer id plus an optional operator note. */
export interface FarmerOfWeek {
  id: string;
  note: string | null;
}

/** The tenant-settings pointer that drives the highlight (settings.farmerOfWeek). */
export interface FarmerOfWeekConfig {
  farmerId?: string | null;
  note?: string | null;
}

/**
 * Resolve the featured farmer from the settings pointer against the public farmer
 * list. Returns null when unset or when the pointer targets a farmer that isn't in
 * the storefront's public list (deleted, or the tenant isn't multiFarmer).
 */
export function resolveFarmerOfWeek(
  cfg: FarmerOfWeekConfig | null | undefined,
  farmers: { id: string }[],
): FarmerOfWeek | null {
  const id = cfg?.farmerId;
  if (!id || !farmers.some((f) => f.id === id)) return null;
  return { id, note: cfg?.note ?? null };
}
