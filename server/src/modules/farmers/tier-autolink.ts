/**
 * Marketplace tier resolution. An explicit operator tier always wins (including a
 * deliberate downgrade). Otherwise, branding.enabled acts as a floor of 2 — a
 * branded farmer never sits in the base tier — but tier is never lowered.
 */
export function effectiveTier(args: {
  currentTier: number;
  brandingEnabled: boolean;
  explicitTier?: number;
}): number {
  if (args.explicitTier !== undefined) return args.explicitTier;
  const floor = args.brandingEnabled ? 2 : 1;
  return Math.max(args.currentTier, floor);
}
