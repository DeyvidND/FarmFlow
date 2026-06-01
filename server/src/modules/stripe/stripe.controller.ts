import {
  Controller,
  Post,
  Req,
  Headers,
  RawBodyRequest,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Request } from 'express';
import { StripeService } from './stripe.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';

@ApiTags('stripe')
@Controller('stripe')
export class StripeController {
  constructor(private readonly stripeService: StripeService) {}

  // Stripe → server (signed, raw body). Always 200 once verified+handled.
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
