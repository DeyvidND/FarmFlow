import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { ProductsService } from './products.service';
import { PRODUCTS_QUEUE } from '../../common/queue/queue.constants';
import { registerRepeatable } from '../../common/queue/register-repeatable';

@Processor(PRODUCTS_QUEUE)
export class ProductsProcessor extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(ProductsProcessor.name);

  constructor(
    private readonly products: ProductsService,
    @InjectQueue(PRODUCTS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    await registerRepeatable(this.queue, 'expire-promotions', '0 1 * * *');
  }

  async process(_job: Job): Promise<void> {
    try {
      const n = await this.products.expirePromotions();
      if (n) this.logger.log(`[products] expired ${n} promotion(s)`);
    } catch (err) {
      this.logger.error(`[products] expire-promotions failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
