import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { type Database, products, reviews } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { clampLimit, keysetAfter, buildPage, type Paginated } from '../../common/pagination/keyset';
import { decodeCursor } from '../../common/pagination/cursor';
import { PublicCacheService, publicCacheKeys } from '../../common/cache/public-cache.service';
import { CreateReviewDto } from './dto/create-review.dto';
import { UpdateReviewStatusDto } from './dto/update-review-status.dto';
import { orderReviewsByIds } from './home-reviews';

/**
 * Defense-in-depth: reviews are plain text. Strip any HTML tags on submit so a
 * stored `<script>`/`<img onerror>` can never execute even if a downstream
 * (e.g. third-party) storefront renders the body as raw HTML. Known renderers
 * already escape at output; this removes the markup at the source. Preserves
 * text content and line breaks; only tags are dropped.
 */
export function stripTags(s: string | null | undefined): string {
  return (s ?? '').replace(/<[^>]*>/g, '').trim();
}

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
    // Use the shared Redis slug→tenant resolver (warm = zero Postgres), same as the
    // public reads in this module, instead of a dedicated uncached query.
    return (await this.publicCache.resolveTenant(this.db, slug)).id;
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

  /** Picked-for-home reviews: the tenant's PUBLISHED reviews whose ids the farmer
   *  selected in settings.landing.reviews, returned in pick order. Empty when the
   *  block is off or nothing is picked. */
  async findHomeReviews(slug: string): Promise<PublicReview[]> {
    const tenant = await this.publicCache.resolveTenant(this.db, slug);
    const cfg = tenant.landing.reviews;
    if (!cfg.show || cfg.ids.length === 0) return [];

    // Read-hot (every storefront bootstrap), write-rare (farmer rarely re-picks).
    // Cache it like the sibling public reads so a warm home page does zero Postgres.
    // Busted on publish/hide (setStatus) + a landing re-pick (TenantsService.updateLanding).
    const key = publicCacheKeys.homeReviews(tenant.id);
    const cached = await this.publicCache.get<PublicReview[]>(key);
    if (cached) return cached;

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
      .where(
        and(
          eq(reviews.tenantId, tenant.id),
          eq(reviews.status, 'published'),
          inArray(reviews.id, cfg.ids),
        ),
      );

    const result = orderReviewsByIds(cfg.ids, rows).map((r) => ({
      ...r,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    }));
    await this.publicCache.set(key, result);
    return result;
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
      authorName: stripTags(dto.authorName),
      authorLocation: stripTags(dto.authorLocation) || null,
      rating: dto.rating,
      body: stripTags(dto.body),
      status: 'pending',
    });
    return { ok: true, status: 'pending' };
  }

  /* ------------------------------ admin (tenant-scoped) ----------------------------- */

  async listForTenant(
    tenantId: string,
    opts: { status?: string; cursor?: string; limit?: number } = {},
  ): Promise<Paginated<typeof reviews.$inferSelect>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const conds = [eq(reviews.tenantId, tenantId)];
    if (opts.status) {
      conds.push(eq(reviews.status, opts.status as 'pending' | 'published' | 'hidden'));
    }
    if (cur) conds.push(keysetAfter(reviews.createdAt, reviews.id, cur, 'desc'));

    const rows = await this.db
      .select()
      .from(reviews)
      .where(and(...conds))
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(lim + 1);

    return buildPage(rows, lim, (r) => ({ createdAt: r.createdAt!, id: r.id }));
  }

  async setStatus(id: string, tenantId: string, dto: UpdateReviewStatusDto) {
    const [row] = await this.db
      .update(reviews)
      .set({ status: dto.status })
      .where(and(eq(reviews.id, id), eq(reviews.tenantId, tenantId)))
      .returning();
    if (!row) throw new NotFoundException('Ревюто не е намерено');
    // Publishing/hiding changes the public list + average — and can add/remove a
    // farmer-picked review from the home block, so bust that cache too.
    await this.publicCache.del(
      publicCacheKeys.reviews(tenantId),
      publicCacheKeys.homeReviews(tenantId),
    );
    return row;
  }
}
