import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { IMAGE_QUEUE } from '../../common/queue/queue.constants';
import { ImageJobPayload, ImageSanityJobPayload } from '../../common/queue/image-job';
import { ProductsService } from '../products/products.service';
import { FarmersService } from '../farmers/farmers.service';
import { SubcategoriesService } from '../subcategories/subcategories.service';

@Processor(IMAGE_QUEUE, { concurrency: 3 })
export class ImageProcessor extends WorkerHost {
  private readonly logger = new Logger(ImageProcessor.name);

  constructor(
    private readonly products: ProductsService,
    private readonly farmers: FarmersService,
    private readonly subcategories: SubcategoriesService,
    @InjectQueue(IMAGE_QUEUE) private readonly imageQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ImageJobPayload | ImageSanityJobPayload>): Promise<void> {
    if (job.name === 'image-sanity') {
      const { mediaId, tenantId, reasons } = job.data as ImageSanityJobPayload;
      try {
        await this.products.finishImageSanity(mediaId, tenantId, reasons);
      } catch (err) {
        this.logger.error(`[image-sanity] media ${mediaId} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
      return;
    }

    const { entityType, entityId, tenantId, bufferB64, mime, sanityReasons } = job.data as ImageJobPayload;
    const buf = Buffer.from(bufferB64, 'base64');
    try {
      switch (entityType) {
        case 'product-cover': await this.products.finishProductCover(entityId, tenantId, buf, mime); return;
        case 'product-media': {
          const { mediaId } = await this.products.finishProductMedia(entityId, tenantId, buf, mime);
          if (sanityReasons?.length) {
            await this.imageQueue.add('image-sanity', { mediaId, tenantId, reasons: sanityReasons } satisfies ImageSanityJobPayload);
          }
          return;
        }
        case 'farmer-cover': return await this.farmers.finishFarmerCover(entityId, tenantId, buf, mime);
        case 'farmer-media': return await this.farmers.finishFarmerMedia(entityId, tenantId, buf, mime);
        case 'subcategory-cover': return await this.subcategories.finishSubcategoryCover(entityId, tenantId, buf, mime);
        case 'subcategory-media': return await this.subcategories.finishSubcategoryMedia(entityId, tenantId, buf, mime);
        default: this.logger.warn(`[image] unknown entityType=${entityType}`);
      }
    } catch (err) {
      this.logger.error(`[image] ${entityType} ${entityId} failed: ${err instanceof Error ? err.message : String(err)}`);
      throw err; // let BullMQ apply its retry/backoff
    }
  }
}
