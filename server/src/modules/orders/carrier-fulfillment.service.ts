import { Injectable, Inject } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { CarrierRegistry } from './carrier-registry';

/**
 * Routes order fulfillment (auto-create waybill) to the carrier the customer
 * chose at checkout, via the {@link CarrierRegistry} — `carrier = 'speedy'` goes
 * to Speedy, everything else falls through to Econt (whose `autoCreateForOrder`
 * already self-gates on delivery-type / configuration / existing waybill).
 */
@Injectable()
export class CarrierFulfillmentService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly carriers: CarrierRegistry,
  ) {}

  async autoCreateForOrder(orderId: string): Promise<void> {
    const [row] = await this.db
      .select({ carrier: orders.carrier })
      .from(orders)
      .where(eq(orders.id, orderId))
      .limit(1);

    await this.carriers.get(row?.carrier).autoCreateForOrder(orderId);
  }
}
