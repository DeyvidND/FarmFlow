import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { and, eq, inArray, asc, desc, sql } from 'drizzle-orm';
import { type Database, articles, articleMedia } from '@farmflow/db';
import { clampLimit, keysetAfter, type Paginated } from '../../common/pagination/keyset';
import { encodeCursor, decodeCursor } from '../../common/pagination/cursor';
import type {
  Article,
  ArticleMedia,
  ArticleWithMedia,
  NewArticle,
  PublicArticle,
} from '@farmflow/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { StorageService } from '../storage/storage.service';
import { PublicCacheService } from '../../common/cache/public-cache.service';
import { ArticlesCacheService } from './articles-cache.service';
import { CreateArticleDto } from './dto/create-article.dto';
import { UpdateArticleDto } from './dto/update-article.dto';
import { EmbedMediaDto } from './dto/embed-media.dto';
import { ReorderMediaDto } from './dto/reorder-media.dto';
import { ARTICLE_MEDIA_EXT_BY_MIME, articleMediaTypeForMime } from './dto/upload-media.dto';
import { optimizeImage } from '../storage/image.util';
import { slugify, parseEmbed, sanitizeArticleHtml } from './articles.util';

@Injectable()
export class ArticlesService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly storage: StorageService,
    private readonly cache: ArticlesCacheService,
    private readonly publicCache: PublicCacheService,
  ) {}

  // ---- Admin reads (own articles, all statuses) ----

  async findAll(
    tenantId: string,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<Paginated<ArticleWithMedia>> {
    const lim = clampLimit(opts.limit);
    const cur = opts.cursor ? decodeCursor(opts.cursor) : null;
    const conds = [eq(articles.tenantId, tenantId)];
    if (cur) conds.push(keysetAfter(articles.createdAt, articles.id, cur, 'desc'));

    const rows = await this.db
      .select()
      .from(articles)
      .where(and(...conds))
      .orderBy(desc(articles.createdAt), desc(articles.id))
      .limit(lim + 1);

    const hasMore = rows.length > lim;
    const pageRows = hasMore ? rows.slice(0, lim) : rows;
    const items = await this.attachMedia(pageRows);
    const last = pageRows[pageRows.length - 1];
    return {
      items,
      nextCursor:
        hasMore && last ? encodeCursor({ createdAt: last.createdAt!, id: last.id }) : null,
    };
  }

  async findOne(id: string, tenantId: string): Promise<ArticleWithMedia> {
    const [row] = await this.db
      .select()
      .from(articles)
      .where(and(eq(articles.id, id), eq(articles.tenantId, tenantId)))
      .limit(1);
    if (!row) throw new NotFoundException('Статията не е намерена');
    const [withMedia] = await this.attachMedia([row]);
    return withMedia;
  }

  // ---- Admin writes ----

  async create(tenantId: string, dto: CreateArticleDto): Promise<ArticleWithMedia> {
    const slug = await this.uniqueSlug(tenantId, dto.slug?.trim() || dto.title);
    const [row] = await this.db
      .insert(articles)
      .values({
        tenantId,
        title: dto.title.trim(),
        slug,
        excerpt: dto.excerpt ?? null,
        body: dto.body != null ? sanitizeArticleHtml(dto.body) : null,
      })
      .returning();
    await this.cache.invalidate(tenantId);
    return { ...row, media: [] };
  }

  async update(id: string, tenantId: string, dto: UpdateArticleDto): Promise<ArticleWithMedia> {
    const existing = await this.findOne(id, tenantId); // 404 if missing / cross-tenant

    const patch: Partial<NewArticle> = { updatedAt: new Date() };
    if (dto.title !== undefined) patch.title = dto.title.trim();
    if (dto.excerpt !== undefined) patch.excerpt = dto.excerpt;
    if (dto.body !== undefined) patch.body = dto.body == null ? null : sanitizeArticleHtml(dto.body);
    if (dto.slug !== undefined) {
      patch.slug = await this.uniqueSlug(tenantId, dto.slug.trim() || existing.title, id);
    }
    if (dto.status !== undefined) {
      patch.status = dto.status;
      // First publish stamps published_at; keep the original on re-publish.
      if (dto.status === 'published' && !existing.publishedAt) patch.publishedAt = new Date();
    }

    const [row] = await this.db
      .update(articles)
      .set(patch)
      .where(and(eq(articles.id, id), eq(articles.tenantId, tenantId)))
      .returning();
    await this.cache.invalidate(tenantId);
    const [withMedia] = await this.attachMedia([row]);
    return withMedia;
  }

  async remove(id: string, tenantId: string): Promise<{ id: string }> {
    const article = await this.findOne(id, tenantId);

    // Clean up R2 objects: uploaded media + cover (embeds have no stored object).
    for (const m of article.media) {
      if (m.type === 'image' || m.type === 'video') await this.deleteObject(m.url);
    }
    if (article.coverImageUrl) await this.deleteObject(article.coverImageUrl);

    // Sweep inline images (no per-row tracking) by wiping the article's R2 prefix.
    await this.storage.deleteByPrefix(`tenants/${tenantId}/articles/${id}/`);

    await this.db.delete(articleMedia).where(eq(articleMedia.articleId, id));
    await this.db
      .delete(articles)
      .where(and(eq(articles.id, id), eq(articles.tenantId, tenantId)));

    await this.cache.invalidate(tenantId);
    return { id };
  }

  async uploadCover(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<ArticleWithMedia> {
    const article = await this.findOne(id, tenantId);

    const url = await this.store(tenantId, id, 'cover', file);
    if (article.coverImageUrl) await this.deleteObject(article.coverImageUrl);

    const [row] = await this.db
      .update(articles)
      .set({ coverImageUrl: url, updatedAt: new Date() })
      .where(and(eq(articles.id, id), eq(articles.tenantId, tenantId)))
      .returning();
    await this.cache.invalidate(tenantId);
    const [withMedia] = await this.attachMedia([row]);
    return withMedia;
  }

  async addInlineImage(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<{ url: string }> {
    await this.findOne(id, tenantId); // scope check (404 cross-tenant)
    const url = await this.store(tenantId, id, 'inline', file);
    return { url };
  }

  async addMedia(
    id: string,
    tenantId: string,
    file: Express.Multer.File,
  ): Promise<ArticleMedia> {
    await this.findOne(id, tenantId); // scope check

    const url = await this.store(tenantId, id, 'media', file);
    const position = await this.nextPosition(id);
    const [row] = await this.db
      .insert(articleMedia)
      .values({
        articleId: id,
        tenantId,
        type: articleMediaTypeForMime(file.mimetype),
        url,
        position,
      })
      .returning();
    await this.cache.invalidate(tenantId);
    return row;
  }

  async addEmbed(id: string, tenantId: string, dto: EmbedMediaDto): Promise<ArticleMedia> {
    await this.findOne(id, tenantId);

    const parsed = parseEmbed(dto.url);
    if (!parsed) throw new BadRequestException('Невалиден YouTube или Instagram адрес');

    const position = await this.nextPosition(id);
    const [row] = await this.db
      .insert(articleMedia)
      .values({
        articleId: id,
        tenantId,
        type: parsed.type,
        url: dto.url,
        embedId: parsed.embedId,
        caption: dto.caption ?? null,
        position,
      })
      .returning();
    await this.cache.invalidate(tenantId);
    return row;
  }

  async removeMedia(
    id: string,
    mediaId: string,
    tenantId: string,
  ): Promise<{ id: string }> {
    await this.findOne(id, tenantId);

    const [m] = await this.db
      .select()
      .from(articleMedia)
      .where(
        and(
          eq(articleMedia.id, mediaId),
          eq(articleMedia.articleId, id),
          eq(articleMedia.tenantId, tenantId),
        ),
      )
      .limit(1);
    if (!m) throw new NotFoundException('Медията не е намерена');

    if (m.type === 'image' || m.type === 'video') await this.deleteObject(m.url);
    await this.db.delete(articleMedia).where(eq(articleMedia.id, mediaId));
    await this.cache.invalidate(tenantId);
    return { id: mediaId };
  }

  async updateMedia(
    id: string,
    mediaId: string,
    tenantId: string,
    patch: { caption?: string },
  ): Promise<ArticleMedia> {
    await this.findOne(id, tenantId);

    const set: Partial<ArticleMedia> = {};
    if (patch.caption !== undefined) set.caption = patch.caption;

    const [row] = await this.db
      .update(articleMedia)
      .set(set)
      .where(
        and(
          eq(articleMedia.id, mediaId),
          eq(articleMedia.articleId, id),
          eq(articleMedia.tenantId, tenantId),
        ),
      )
      .returning();
    if (!row) throw new NotFoundException('Медията не е намерена');
    await this.cache.invalidate(tenantId);
    return row;
  }

  async reorderMedia(
    id: string,
    tenantId: string,
    dto: ReorderMediaDto,
  ): Promise<ArticleMedia[]> {
    await this.findOne(id, tenantId);

    // Scope each update by article + tenant so foreign media ids are no-ops.
    // One transaction so a mid-loop failure can't leave a half-applied order.
    await this.db.transaction(async (tx) => {
      for (const it of dto.items) {
        await tx
          .update(articleMedia)
          .set({ position: it.position })
          .where(
            and(
              eq(articleMedia.id, it.id),
              eq(articleMedia.articleId, id),
              eq(articleMedia.tenantId, tenantId),
            ),
          );
      }
    });
    await this.cache.invalidate(tenantId);

    return this.db
      .select()
      .from(articleMedia)
      .where(eq(articleMedia.articleId, id))
      .orderBy(asc(articleMedia.position));
  }

  // ---- Public (storefront) reads — published only, Redis-cached ----

  async findPublicBySlug(slug: string): Promise<PublicArticle[]> {
    const tenant = await this.tenantBySlug(slug);

    const cached = (await this.cache.get(tenant.id)) as PublicArticle[] | null;
    if (cached) return cached;

    const rows = await this.db
      .select()
      .from(articles)
      .where(and(eq(articles.tenantId, tenant.id), eq(articles.status, 'published')))
      .orderBy(desc(articles.publishedAt));

    const result = (await this.attachMedia(rows)).map(toPublicArticle);
    await this.cache.set(tenant.id, result, 300);
    return result;
  }

  async findPublicArticleBySlug(slug: string, articleSlug: string): Promise<PublicArticle> {
    const tenant = await this.tenantBySlug(slug);

    const [row] = await this.db
      .select()
      .from(articles)
      .where(
        and(
          eq(articles.tenantId, tenant.id),
          eq(articles.slug, articleSlug),
          eq(articles.status, 'published'),
        ),
      )
      .limit(1);
    if (!row) throw new NotFoundException('Статията не е намерена');

    const [withMedia] = await this.attachMedia([row]);
    return toPublicArticle(withMedia);
  }

  // ---- Helpers ----

  /** Batch-load media for a set of articles (no N+1) and attach, ordered by position. */
  private async attachMedia(rows: Article[]): Promise<ArticleWithMedia[]> {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const media = await this.db
      .select()
      .from(articleMedia)
      .where(inArray(articleMedia.articleId, ids))
      .orderBy(asc(articleMedia.position));

    const byArticle = new Map<string, ArticleMedia[]>();
    for (const m of media) {
      const list = byArticle.get(m.articleId!) ?? [];
      list.push(m);
      byArticle.set(m.articleId!, list);
    }
    return rows.map((a) => ({ ...a, media: byArticle.get(a.id) ?? [] }));
  }

  private async uniqueSlug(tenantId: string, base: string, excludeId?: string): Promise<string> {
    const root = slugify(base) || 'article';
    let candidate = root;
    let n = 2;
    // Slugs are unique per tenant; bump a numeric suffix until free.
    for (;;) {
      const [hit] = await this.db
        .select({ id: articles.id })
        .from(articles)
        .where(and(eq(articles.tenantId, tenantId), eq(articles.slug, candidate)))
        .limit(1);
      if (!hit || hit.id === excludeId) return candidate;
      candidate = `${root}-${n++}`;
    }
  }

  private async nextPosition(articleId: string): Promise<number> {
    const [row] = await this.db
      .select({ max: sql<number>`coalesce(max(${articleMedia.position}), -1)` })
      .from(articleMedia)
      .where(eq(articleMedia.articleId, articleId));
    return (row?.max ?? -1) + 1;
  }

  private async store(
    tenantId: string,
    articleId: string,
    kind: 'cover' | 'media' | 'inline',
    file: Express.Multer.File,
  ): Promise<string> {
    // Images get downscaled+re-encoded; video (article media) passes through.
    const img = await optimizeImage(
      file.buffer,
      file.mimetype,
      ARTICLE_MEDIA_EXT_BY_MIME[file.mimetype] ?? 'bin',
    );
    const key = `tenants/${tenantId}/articles/${articleId}/${kind}/${randomUUID()}.${img.ext}`;
    const { url } = await this.storage.upload(img.buffer, key, img.contentType);
    return url;
  }

  private async tenantBySlug(slug: string): Promise<{ id: string }> {
    // Shared Redis slug→tenant resolver (same key the other public reads use) so a
    // warm storefront render does no Postgres tenant lookup for articles either.
    return this.publicCache.resolveTenant(this.db, slug);
  }

  /** Best-effort removal of a stored object given its public URL. */
  private async deleteObject(url: string): Promise<void> {
    try {
      const key = new URL(url).pathname.replace(/^\/+/, '');
      if (key) await this.storage.delete(key);
    } catch {
      // a storage hiccup must not block the DB write
    }
  }
}

/** Strip tenant + email-only fields before exposing an article publicly. */
function toPublicArticle(a: ArticleWithMedia): PublicArticle {
  const { tenantId, sentAt, media, ...rest } = a;
  return {
    ...rest,
    media: media.map(({ tenantId: _t, articleId: _a, ...m }) => m),
  };
}
