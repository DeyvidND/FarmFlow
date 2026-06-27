import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';

/**
 * Routes order fulfillment (auto-create waybill) to the carrier the customer
 * chose at checkout.  Door orders with `carrier = 'speedy'` are dispatched to
 * Speedy; everything else falls through to Econt, whose `autoCreateForOrder`
 * already self-gates on delivery-type / configuration / existing waybill.
 */
@Injectable()
export class CarrierFulfillmentService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly econt: EcontService,
    private readonly speedy: SpeedyService,
  ) {}

  async autoCreateForOrder(orderId: string): Promise<void> {
    const [row] = await this.db
      .select({ carrier: orders.carrier })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    if (row?.carrier === 'speedy') {
      await this.speedy.autoCreateForOrder(orderId);
      return;
    }
    await this.econt.autoCreateForOrder(orderId);
  }
}
