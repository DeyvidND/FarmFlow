import { Module } from '@nestjs/common';
import { CommissionService } from './commission.service';
import { VendorSubscriptionService } from './vendor-subscription.service';
import { VendorFinanceController } from './vendor-finance.controller';
import { VendorFinanceSettingsService } from './vendor-finance-settings.service';

/**
 * DORMANT vendor-finance ledgers (commission + vendor monthly subscriptions).
 * Exported CommissionService is injected @Optional() into the order/stripe money
 * seams — with the per-tenant settings switch off it records 0-rate entries and
 * charges nothing. See vendor-finance.settings.ts for how to wake it up.
 */
@Module({
  controllers: [VendorFinanceController],
  providers: [CommissionService, VendorSubscriptionService, VendorFinanceSettingsService],
  // Both services are reused by the super-admin marketplace-finance controller
  // (platform-scoped oversight over the same dormant ledgers).
  exports: [CommissionService, VendorSubscriptionService],
})
export class VendorFinanceModule {}
