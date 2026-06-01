import { Controller, Post, Param, Body } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CheckoutService } from './checkout.service';
import { CreateOrderDto } from './dto/create-order.dto';

/**
 * Public storefront checkout. Same body as `POST /public/:slug/orders`, but
 * returns `{ orderId, checkoutUrl }` — redirect to `checkoutUrl` when present
 * (Stripe), otherwise the order is placed for cash and the client goes to the
 * confirmation page.
 */
@ApiTags('public')
@Controller('public/:slug/checkout')
export class PublicCheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  create(@Param('slug') slug: string, @Body() dto: CreateOrderDto) {
    return this.checkout.create(slug, dto);
  }
}
