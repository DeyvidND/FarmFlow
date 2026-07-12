/** Seller go-live readiness for the farmer-as-seller marketplace. A producer may only
 *  be flipped to a live seller once (1) the buyer can be shown who they contract with —
 *  КЗП requires a legal name + an identifier (ЕИК for ЕТ/фирма, else рег. № земеделски
 *  производител) + a registered address — AND (2) the farmer collects their own наложен
 *  платеж, i.e. has their own carrier account connected (so Econt/Speedy settle COD to the
 *  farmer, not the tenant). `missing` lists the outstanding items so the operator can chase
 *  them. Pure — the service passes the farmer's `legal` blob + whether a carrier is connected. */
export interface SellerReadiness {
  ready: boolean;
  hasLegalIdentity: boolean;
  hasOwnCarrier: boolean;
  /** Human-facing Bulgarian labels for what's still missing (empty when ready). */
  missing: string[];
}

export function farmerSellerReadiness(
  legal: { name?: string; eik?: string; regNo?: string; address?: string } | null | undefined,
  ownCarrierConnected: boolean,
): SellerReadiness {
  const name = (legal?.name ?? '').trim();
  const address = (legal?.address ?? '').trim();
  // ЕИК/БУЛСТАТ (ЕТ/фирма) OR рег. № земеделски производител (физ. лице) — either satisfies КЗП.
  const identifier = ((legal?.eik ?? '').trim() || (legal?.regNo ?? '').trim());
  const hasLegalIdentity = !!(name && identifier && address);
  const missing: string[] = [];
  if (!name) missing.push('юридическо име');
  if (!identifier) missing.push('ЕИК/рег. номер');
  if (!address) missing.push('адрес на продавача');
  if (!ownCarrierConnected) missing.push('свой куриерски акаунт');
  return { ready: hasLegalIdentity && ownCarrierConnected, hasLegalIdentity, hasOwnCarrier: ownCarrierConnected, missing };
}

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
