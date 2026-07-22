import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { type Database, consolidatedProtocols } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { RoutingService } from '../routing/routing.service';
import { CourierAssignmentService } from '../routing/courier-assignment.service';

export type ConsolidatedScope = 'day' | 'leg';

export interface ConsolidatedProtocolSummary {
  id: string | null;
  scope: ConsolidatedScope;
  legIndex: number | null;
  date: string;
  docNumber: number | null;
  status: 'draft' | 'signed' | null;
}

function targetMatch(tenantId: string, date: string, scope: ConsolidatedScope, legIndex?: number | null) {
  return and(
    eq(consolidatedProtocols.tenantId, tenantId),
    eq(consolidatedProtocols.date, date),
    eq(consolidatedProtocols.scope, scope),
    scope === 'day' ? isNull(consolidatedProtocols.legIndex) : eq(consolidatedProtocols.legIndex, legIndex!),
  );
}

/**
 * Обобщен приемо-предавателен протокол (consolidated day/leg handover
 * protocol) — see docs/superpowers/specs/2026-07-21-consolidated-handover-protocol-design.md
 * and the schema comment on `consolidatedProtocols` (@fermeribg/db). Content
 * (which farmers/orders) is NEVER stored while status='draft' — it is
 * recomputed live on every read from orders/order_items/products/farmers,
 * exactly like the existing bilateral protocol's DayProtocolRow live view
 * (HandoverService). Only meta/overrides/status persist here until sign()
 * freezes the computed rows into frozen_rows.
 */
@Injectable()
export class ConsolidatedProtocolService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly routing: RoutingService,
    private readonly courierAssignment: CourierAssignmentService,
  ) {}

  /** Materializes a draft row (assigning its doc_number) if one doesn't exist yet
   *  for this (tenant, date, scope, legIndex) target; otherwise returns the
   *  existing id. Same race-safe pattern as HandoverService.ensureDraftTarget:
   *  a fast-path pre-check, then an advisory-lock-guarded re-check + insert. */
  async ensureDraft(
    tenantId: string,
    date: string,
    scope: ConsolidatedScope,
    legIndex?: number,
  ): Promise<{ id: string }> {
    if (scope === 'leg' && legIndex == null) {
      throw new BadRequestException('Изисква се номер на лег.');
    }
    const match = targetMatch(tenantId, date, scope, legIndex);

    const [existing] = await this.db
      .select({ id: consolidatedProtocols.id })
      .from(consolidatedProtocols)
      .where(match)
      .limit(1);
    if (existing) return { id: existing.id };

    const inserted = await this.db.transaction(async (tx) => {
      // Distinct lock discriminator from handover_protocols' own
      // hashtextextended(tenantId, 0) — the two series don't need to
      // serialize against each other, only against themselves.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId} || ':consolidated', 0))`);
      const [dupe] = await tx
        .select({ id: consolidatedProtocols.id })
        .from(consolidatedProtocols)
        .where(match)
        .limit(1);
      if (dupe) return dupe;

      const [{ max }] = await tx
        .select({ max: sql<number | null>`max(${consolidatedProtocols.docNumber})` })
        .from(consolidatedProtocols)
        .where(eq(consolidatedProtocols.tenantId, tenantId));

      const [row] = await tx
        .insert(consolidatedProtocols)
        .values({
          tenantId,
          scope,
          date,
          legIndex: scope === 'leg' ? legIndex! : null,
          docNumber: (max ?? 0) + 1,
          status: 'draft',
          meta: {},
          overrides: {},
        })
        .returning({ id: consolidatedProtocols.id });
      return row;
    });

    return { id: inserted.id };
  }

  /** The day's protocol targets: the day-scope document plus one per courier
   *  leg ACTUALLY assigned that day (route_courier_assignments — never
   *  invented, per spec §2). A target with no persisted row yet comes back as
   *  a virtual placeholder (id=null) so the list is populated before anything
   *  is created — same idiom as HandoverService.listForDay's virtual rows. */
  async listForDay(tenantId: string, date: string): Promise<ConsolidatedProtocolSummary[]> {
    const persisted = await this.db
      .select()
      .from(consolidatedProtocols)
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.date, date)));

    const toSummary = (r: (typeof persisted)[number]): ConsolidatedProtocolSummary => ({
      id: r.id,
      scope: r.scope as ConsolidatedScope,
      legIndex: r.legIndex,
      date: r.date,
      docNumber: r.docNumber,
      status: r.status as 'draft' | 'signed',
    });

    const byKey = new Map(persisted.map((r) => [`${r.scope}:${r.legIndex ?? 'day'}`, r]));
    const out: ConsolidatedProtocolSummary[] = [];

    const dayRow = byKey.get('day:day');
    out.push(
      dayRow
        ? toSummary(dayRow)
        : { id: null, scope: 'day', legIndex: null, date, docNumber: null, status: null },
    );

    const board = await this.courierAssignment.getAssignmentsForDay(tenantId, date);
    const legIndexes = [...new Set(board.map((a) => a.legIndex))].sort((a, b) => a - b);
    for (const legIndex of legIndexes) {
      const row = byKey.get(`leg:${legIndex}`);
      out.push(
        row ? toSummary(row) : { id: null, scope: 'leg', legIndex, date, docNumber: null, status: null },
      );
    }
    return out;
  }
}
