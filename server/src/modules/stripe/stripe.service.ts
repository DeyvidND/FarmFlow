import { Injectable, NotImplementedException } from '@nestjs/common';

@Injectable()
export class StripeService {
  handleWebhook(_rawBody: Buffer, _signature: string): void {
    throw new NotImplementedException('Stripe webhook not yet implemented');
  }
}
