/** Default `tenants.settings` for a sellable farm: market pickup + COD + card on,
 *  own slots and Econt off. `themeColor` (auto-extracted from a logo at onboarding)
 *  is stored under `brand` where the storefront + Контакти read it. */
export function farmDefaultSettings(themeColor?: string): Record<string, unknown> {
  return {
    ...(themeColor ? { brand: { themeColor } } : {}),
    delivery: {
      methods: {
        pickup: { enabled: true },
        ownSlots: { enabled: false },
        econtOffice: { enabled: false },
        econtAddress: { enabled: false },
      },
      cod: { enabled: true },
      card: { enabled: true },
      econt: { mode: 'off' },
    },
  };
}
