import {
  Controller,
  Post,
  Get,
  Req,
  Headers,
  RawBodyRequest,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Request } from 'express';
import { StripeService } from './stripe.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('stripe')
@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  // Stripe → server (signed, raw body). Always 200 once verified+handled.
  // Signature-verified + idempotent, so it must not be rate-limited (would drop
  // legitimate Stripe retry bursts).
  @SkipThrottle()
  @Post('webhook')
  @HttpCode(200)
  handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    return this.stripeService.handleWebhook(req.rawBody!, signature);
  }
}

/** Tenant-scoped admin trigger to (re)sync the farm's products into its Stripe catalog. */
@ApiTags('stripe')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stripe/catalog')
export class StripeCatalogController {
  constructor(private readonly stripeService: StripeService) {}

  @Post('sync')
  sync(@CurrentTenant() tenantId: string) {
    return this.stripeService.syncCatalog(tenantId);
  }
}

/** Tenant-scoped Stripe Connect onboarding — self-serve account link + status. */
@ApiTags('stripe')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('stripe/connect')
export class StripeConnectController {
  constructor(private readonly stripeService: StripeService) {}

  /** Create (if needed) the farm's connected account and return a hosted onboarding URL. */
  @Post('onboard')
  onboard(@CurrentTenant() tenantId: string) {
    return this.stripeService.createOnboardingLink(tenantId);
  }

  /** Onboarding/payment-readiness of the farm's connected account. */
  @Get('status')
  status(@CurrentTenant() tenantId: string) {
    return this.stripeService.accountStatus(tenantId);
  }

  /** Connection state + balance / next-payout summary for the Payments page. */
  @Get('summary')
  summary(@CurrentTenant() tenantId: string) {
    return this.stripeService.connectSummary(tenantId);
  }
}
