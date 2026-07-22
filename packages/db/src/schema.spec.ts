import { orders } from './schema';

/**
 * Phase 2 (2026-07-22): asserts orders' protocol-email tracking columns are
 * present in the Drizzle-inferred row type. This package has no jest/test
 * runner configured (see package.json) — `tsc` (via
 * `pnpm --filter @fermeribg/db build`) IS the check here: this file sits
 * under tsconfig's `include: ["src"]`, so a missing/renamed column fails the
 * package build with a precise TS2339, not silently.
 */
type OrderRow = typeof orders.$inferSelect;

function assertHasProtocolEmailColumns(row: OrderRow): void {
  const status: string | null = row.protocolEmailStatus;
  const at: Date | null = row.protocolEmailAt;
  const error: string | null = row.protocolEmailError;
  void status;
  void at;
  void error;
}
void assertHasProtocolEmailColumns;
