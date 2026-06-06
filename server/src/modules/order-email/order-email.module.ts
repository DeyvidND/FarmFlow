import { Module } from '@nestjs/common';
import { OrderConfirmationService } from './order-confirmation.service';

/**
 * Self-contained module for buyer order emails. Depends only on the global
 * DrizzleModule (DB_TOKEN) + EmailModule (EmailService), so both OrdersModule
 * and StripeModule can import it without creating a circular dependency
 * (OrdersModule → StripeModule already exists).
 */
@Module({
  providers: [OrderConfirmationService],
  exports: [OrderConfirmationService],
})
export class OrderEmailModule {}
