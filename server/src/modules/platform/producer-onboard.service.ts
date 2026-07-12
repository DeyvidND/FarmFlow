import { Inject, Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import { type Database, users } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { FarmersService } from '../farmers/farmers.service';
import { ProductsService } from '../products/products.service';
import { AuthService } from '../auth/auth.service';
import { ProductExtractService, isImageFile } from '../ai-import/product-extract.service';
import { OnboardProducerDto } from './dto/onboard-producer.dto';

export interface OnboardResult {
  farmerId: string;
  productsCreated: number;
  inviteLink: string | null;
}

/**
 * One operator action = a working producer: create the farmer under the brand
 * tenant, AI-import their price list (photo or text) attached to their id, and
 * mint a 7-day single-use set-password link the operator shares over Viber.
 * Sequential on purpose — each stage's failure message tells the operator
 * exactly which part to retry.
 */
@Injectable()
export class ProducerOnboardService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly farmers: FarmersService,
    private readonly extract: ProductExtractService,
    private readonly products: ProductsService,
    private readonly auth: AuthService,
    private readonly config: ConfigService,
  ) {}

  async onboard(
    tenantId: string,
    dto: OnboardProducerDto,
    file: Express.Multer.File | undefined,
  ): Promise<OnboardResult> {
    const farmer = await this.farmers.create(tenantId, { name: dto.name, phone: dto.phone });

    let productsCreated = 0;
    if ((file && isImageFile(file)) || dto.pricelistText?.trim()) {
      const rows =
        file && isImageFile(file)
          ? await this.extract.extractFromImage(file)
          : await this.extract.extract(dto.pricelistText!.trim());
      for (const p of rows) {
        await this.products.create(tenantId, { ...p, farmerId: farmer.id }, farmer.id);
        productsCreated++;
      }
    }

    let inviteLink: string | null = null;
    if (dto.email) {
      await this.farmers.grantAccess(tenantId, farmer.id, dto.email);
      const [user] = await this.db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.farmerId, farmer.id), eq(users.tenantId, tenantId)))
        .limit(1);
      if (!user) throw new InternalServerErrorException('Достъпът е създаден, но профилът не бе намерен.');
      const appUrl = this.config.get<string>('PUBLIC_APP_URL') ?? 'http://localhost:3000';
      const { link } = await this.auth.issueInvite(user.id, {
        appUrl,
        email: false, // grantAccess already emailed; this link is for Viber sharing
        subject: 'Покана за достъп — ФермериБГ',
      });
      inviteLink = link;
    }

    return { farmerId: farmer.id, productsCreated, inviteLink };
  }
}
