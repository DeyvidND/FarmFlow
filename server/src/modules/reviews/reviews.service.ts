import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import { type Database, tenants, products, reviews } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';

/** Cap on reviews returned to the storefront; count/average still cover all. */
const PUBLIC_REVIEWS_LIMIT = 60;

export interface PublicReview {
  id: string;
  authorName: string;
  authorLocation: string | null;
  rating: number;
  body: string;
  createdAt: string | null;
}

export interface ReviewSummary {
  average: number; // 0 when none, else 1-decimal mean of published
  count: number;
  reviews: PublicReview[];
}

@Injectable()
export class ReviewsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly publicCache: PublicCacheService,
  ) {}

  private async resolveTenantId(slug: string): Promise<string> {
    const [tenant] = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Фермата не е намерена');
    return tenant.id;
  }

  /** Public: published reviews + average rating + count. */
  async findPublic(slug: string): Promise<ReviewSummary> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);

    const key = publicCacheKeys.reviews(tenant.id);
    const cached = await this.publicCache.get<ReviewSummary>(key);
    if (cached) return cached;

    const published = and(eq(reviews.tenantId, tenant.id), eq(reviews.status, 'published'));

    // Count + average over ALL published reviews via SQL, so capping the returned
    // list below never skews the headline figures.
    const [agg] = await this.db
      .select({
        count: sql<number>`count(*)::int`,
        average: sql<number>`coalesce(round(avg(${reviews.rating}), 1), 0)::float`,
      })
      .from(reviews)
      .where(published);

    // Bounded list: the storefront shows the most recent reviews, not thousands.
    const rows = await this.db
      .select({
        id: reviews.id,
        authorName: reviews.authorName,
        authorLocation: reviews.authorLocation,
        rating: reviews.rating,
        body: reviews.body,
        createdAt: reviews.createdAt,
      })
      .from(reviews)
      .where(published)
      .orderBy(desc(reviews.createdAt))
      .limit(PUBLIC_REVIEWS_LIMIT);

    const summary: ReviewSummary = {
      average: agg?.average ?? 0,
      count: agg?.count ?? 0,
      reviews: rows.map((r) => ({
        ...r,
        createdAt: r.createdAt ? r.createdAt.toISOString() : null,
      })),
    };
    await this.publicCache.set(key, summary);
    return summary;
  }

  /** Public submission → stored as `pending` for moderation. */
  async create(slug: string, dto: CreateReviewDto): Promise<{ ok: true; status: 'pending' }> {
    const tenantId = await this.resolveTenantId(slug);

    if (dto.productId) {
      const [p] = await this.db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.id, dto.productId), eq(products.tenantId, tenantId)))
        .limit(1);
      if (!p) throw new BadRequestException('Невалиден продукт');
    }

    await this.db.insert(reviews).values({
      tenantId,
      productId: dto.productId ?? null,
      authorName: dto.authorName.trim(),
      authorLocation: dto.authorLocation?.trim() || null,
      rating: dto.rating,
      body: dto.body.trim(),
      status: 'pending',
    });
    return { ok: true, status: 'pending' };
  }

  /* ------------------------------ admin (tenant-scoped) ----------------------------- */

  listForTenant(tenantId: string, status?: string) {
    const conds = [eq(reviews.tenantId, tenantId)];
    if (status) conds.push(eq(reviews.status, status as 'pending' | 'published' | 'hidden'));
    return this.db
      .select()
      .from(reviews)
      .where(and(...conds))
      .orderBy(desc(reviews.createdAt));
  }

  async setStatus(id: string, tenantId: string, dto: UpdateReviewStatusDto) {
    const [row] = await this.db
      .update(reviews)
      .set({ status: dto.status })
      .where(and(eq(reviews.id, id), eq(reviews.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Ревюто не е намерено');
    // Publishing/hiding changes the public list + average.
    await this.publicCache.del(publicCacheKeys.reviews(tenantId));
    return row;
  }
}
