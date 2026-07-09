import { Injectable, Inject } from '@nestjs/common';
import { eq, gte, sql } from 'drizzle-orm';
import { type Database, errorEvents, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { PlatformService } from './platform.service';
import { PlatformInsightsService, type SignalKey } from './insights.service';

export type ProblemSeverity = 'high' | 'med' | 'low';

/** One unified cross-farm problem row for the super-admin «Проблеми» feed.
 *  Response shape is FIXED — the admin UI depends on it exactly as-is. */
export interface PlatformProblem {
  severity: ProblemSeverity;
  /** Machine key, e.g. 'server_error' | 'stuck_shipment' | 'empty_shop' | 'dormant' |
   *  'stripe_incomplete' | 'econt_incomplete' | 'cod_outstanding' | ... */
  kind: string;
  tenantId: string | null;
  tenantName: string | null;
  /** Short BG label, e.g. „Сървърни грешки". */
  title: string;
  /** BG specifics, e.g. „7 грешки за 24ч по /orders". */
  detail: string;
  count?: number;
  /** ISO timestamp. */
  lastAt?: string;
}

export interface ProblemsResponse {
  items: PlatformProblem[];
  generatedAt: string;
  notes?: string[];
}

// Recent-error window + cap. If more (tenant, path) combinations exist in the
// window than the cap, we truncate to the noisiest and say so in `notes` —
// never silently drop the fact that the feed is incomplete.
const ERROR_WINDOW_HOURS = 48;
const ERROR_TOP_N = 50;

// Maps each `insights.service.ts` attention signal to a problem severity + BG
// title. Kept as an explicit table (not a formula) so the mapping stays
// legible and each signal's real-world urgency can be tuned independently of
// its internal `severity` number (which insights.service.ts uses only to sort
// a farm's own signal chips, not to compare across farms/kinds).
const SIGNAL_MAP: Record<SignalKey, { severity: ProblemSeverity; kind: string; title: string }> = {
  empty_shop: { severity: 'high', kind: 'empty_shop', title: 'Няма активни продукти' },
  no_orders: { severity: 'med', kind: 'no_orders', title: 'Има продукти, но няма поръчки' },
  stripe_incomplete: { severity: 'med', kind: 'stripe_incomplete', title: 'Картовите плащания не работят' },
  dormant: { severity: 'med', kind: 'dormant', title: 'Няма поръчки отдавна' },
  econt_incomplete: { severity: 'low', kind: 'econt_incomplete', title: 'Econt не е довършен' },
  dropping: { severity: 'low', kind: 'dropping', title: 'Поръчките падат рязко' },
};

const SEVERITY_RANK: Record<ProblemSeverity, number> = { high: 0, med: 1, low: 2 };

/**
 * Unified, severity-ranked cross-farm problems feed for the super-admin
 * «Проблеми» screen. Every item is backed by a real query — nothing here is
 * invented; a source that can't be cheaply/reliably grounded is omitted, with
 * a note explaining why (see `problems()`).
 */
@Injectable()
export class ProblemsService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly platform: PlatformService,
    private readonly insights: PlatformInsightsService,
  ) {}

  async problems(): Promise<ProblemsResponse> {
    const notes: string[] = [];

    const [errorItems, insightItems, deliveryItems] = await Promise.all([
      this.errorProblems(notes),
      this.insightProblems(),
      this.deliveryProblems(notes),
    ]);

    const items = [...errorItems, ...insightItems, ...deliveryItems].sort((a, b) => {
      const sevDiff = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
      if (sevDiff !== 0) return sevDiff;
      const countDiff = (b.count ?? 0) - (a.count ?? 0);
      if (countDiff !== 0) return countDiff;
      const aTime = a.lastAt ? new Date(a.lastAt).getTime() : 0;
      const bTime = b.lastAt ? new Date(b.lastAt).getTime() : 0;
      return bTime - aTime;
    });

    return { items, generatedAt: new Date().toISOString(), notes: notes.length ? notes : undefined };
  }

  /** Source 1: recent 5xx failures (last 48h) from `error_events`, grouped by
   *  (tenant, path) with counts, joined to the tenant name. Capped to the
   *  noisiest ERROR_TOP_N combinations. */
  private async errorProblems(notes: string[]): Promise<PlatformProblem[]> {
    const since = new Date(Date.now() - ERROR_WINDOW_HOURS * 60 * 60 * 1000);
    const rows = await this.db
      .select({
        tenantId: errorEvents.tenantId,
        tenantName: tenants.name,
        path: errorEvents.path,
        count: sql<number>`count(*)::int`,
        lastAt: sql<Date | null>`max(${errorEvents.createdAt})`,
      })
      .from(errorEvents)
      .leftJoin(tenants, eq(errorEvents.tenantId, tenants.id))
      .where(gte(errorEvents.createdAt, since))
      .groupBy(errorEvents.tenantId, tenants.name, errorEvents.path)
      .orderBy(sql`count(*) desc`)
      .limit(ERROR_TOP_N + 1);

    const capped = rows.length > ERROR_TOP_N;
    const page = capped ? rows.slice(0, ERROR_TOP_N) : rows;
    if (capped) {
      notes.push(
        `Сървърните грешки са показани само за топ ${ERROR_TOP_N} комбинации ферма/път за последните ${ERROR_WINDOW_HOURS}ч — има още.`,
      );
    }

    return page.map((r) => ({
      severity: 'high' as const,
      kind: 'server_error',
      tenantId: r.tenantId,
      tenantName: r.tenantName ?? null,
      title: 'Сървърни грешки',
      detail: `${r.count} грешки за ${ERROR_WINDOW_HOURS}ч по ${r.path}`,
      count: r.count,
      lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : undefined,
    }));
  }

  /** Source 2: reuse the attention signals already computed for the «Анализ»
   *  screen (empty shop, no orders, dormant, dropping, Stripe/Econt incomplete).
   *  Demo tenants are already excluded inside insights.service.ts — kept as-is. */
  private async insightProblems(): Promise<PlatformProblem[]> {
    const { signals } = await this.insights.insights();
    const items: PlatformProblem[] = [];
    for (const farm of signals) {
      for (const s of farm.signals) {
        const mapped = SIGNAL_MAP[s.key];
        if (!mapped) continue; // defensive: unknown future signal key, skip rather than guess.
        items.push({
          severity: mapped.severity,
          kind: mapped.kind,
          tenantId: farm.tenantId,
          tenantName: farm.name,
          title: mapped.title,
          detail: s.label,
        });
      }
    }
    return items;
  }

  /** Source 3: reuse deliveryOps() — stuck courier drafts (per farm) + the
   *  platform-wide COD-outstanding total. The latter has no per-farm breakdown
   *  in deliveryOps() today, so it surfaces as one tenantId:null row (noted). */
  private async deliveryProblems(notes: string[]): Promise<PlatformProblem[]> {
    const ops = await this.platform.deliveryOps();
    const items: PlatformProblem[] = [];

    for (const d of ops.stuckDrafts) {
      items.push({
        severity: 'med',
        kind: 'stuck_shipment',
        tenantId: d.tenantId,
        tenantName: d.tenantName,
        title: 'Заседнали товарителници',
        detail:
          `${d.count} чернови товарителници за ${d.farmerName}` +
          (d.oldestAt ? `, най-старата от ${new Date(d.oldestAt).toLocaleDateString('bg-BG')}` : ''),
        count: d.count,
        lastAt: d.oldestAt ? new Date(d.oldestAt).toISOString() : undefined,
      });
    }

    if (ops.cod.outstandingStotinki > 0) {
      notes.push(
        'Неуредените наложени платежи са обобщен показател за цялата платформа — deliveryOps() няма разбивка по ферма без нова заявка.',
      );
      items.push({
        severity: 'low',
        kind: 'cod_outstanding',
        tenantId: null,
        tenantName: null,
        title: 'Неуредени наложени платежи',
        detail: `${(ops.cod.outstandingStotinki / 100).toFixed(2)} лв. събрани от куриер, но неуредени с фермите`,
        count: ops.cod.outstandingStotinki,
      });
    }

    return items;
  }
}
