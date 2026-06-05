import { Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

/** Tenant-scoped SaaS billing — subscription summary, card checkout, billing portal. */
@ApiTags('billing')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('billing')
export class BillingController {
  constructor(private readonly billing: BillingService) {}

  /** Subscription snapshot for the Payments page (plan, status, card, estimate). */
  @Get('summary')
  summary(@CurrentTenant() tenantId: string) {
    return this.billing.summary(tenantId);
  }

  /** Hosted Checkout (subscription mode) to add a card + start the €30/mo plan. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('checkout')
  checkout(@CurrentTenant() tenantId: string) {
    return this.billing.startCheckout(tenantId);
  }

  /** Stripe Billing Portal session (manage card / invoices / cancel). */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('portal')
  portal(@CurrentTenant() tenantId: string) {
    return this.billing.billingPortal(tenantId);
  }
}
