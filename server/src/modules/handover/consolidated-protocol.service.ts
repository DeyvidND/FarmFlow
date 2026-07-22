import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  type Database, consolidatedProtocols, deliverySlots, farmers, orderItems, orders, products,
} from '@fermeribg/db';
import type { LegalIdentity } from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { decryptSignature } from '../../common/crypto/signature-crypto';
import { cityFromAddress } from './handover-city';
import type { ProtocolItemDto } from './dto/create-protocol.dto';
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

/** Same handover-ready statuses as HandoverService.HANDOVER_STATUSES — kept as
 *  its own local constant (not imported) so this file has no coupling to the
 *  bilateral service's internals; both must be kept in sync by hand if the
 *  prep/handover window statuses ever change. */
const HANDOVER_STATUSES = ['confirmed', 'preparing'] as const;

export interface ConsolidatedFarmerRow {
  farmerId: string;
  name: string;
  legal: LegalIdentity | null;
  items: ProtocolItemDto[];
  signaturePng: string | null;
  batch?: string;
  eDoc?: string;
  note?: string;
}

export interface ConsolidatedOrderRow {
  orderId: string;
  orderNumber: number | null;
  customerCode: string;
  cityOrZone: string | null;
  items: ProtocolItemDto[];
  totalStotinki: number;
  batch?: string;
  eDoc?: string;
  note?: string;
}

export interface ConsolidatedProtocolRows {
  farmers: ConsolidatedFarmerRow[];
  orders: ConsolidatedOrderRow[];
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

  /** The order ids in scope for a target: EVERY handover-ready order in the
   *  date's slots for scope='day' (mirrors HandoverService.resolveSlotIds +
   *  its status filter); ONLY the orders on that courier's own route leg for
   *  scope='leg' — the exact mechanism GET /handover/check already uses
   *  (getRoute(..., 'all') + filter by courierIndex), so a leg's cargo can
   *  never include another courier's stops. */
  private async resolveScopeOrderIds(
    tenantId: string,
    date: string,
    scope: ConsolidatedScope,
    legIndex?: number | null,
  ): Promise<string[]> {
    if (scope === 'leg') {
      const route = await this.routing.getRoute(tenantId, date, undefined, undefined, undefined, 'all');
      return [
        ...new Set(
          route.routes
            .filter((r: { courierIndex: number }) => r.courierIndex === legIndex)
            .flatMap((r: { stops: { id: string }[] }) => r.stops.map((s) => s.id)),
        ),
      ];
    }
    const slotRows = await this.db
      .select({ id: deliverySlots.id })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.tenantId, tenantId), eq(deliverySlots.date, date)));
    if (slotRows.length === 0) return [];
    const slotIds = slotRows.map((r) => r.id);
    const orderRows = await this.db
      .select({ id: orders.id })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.slotId, slotIds),
          inArray(orders.status, [...HANDOVER_STATUSES]),
        ),
      );
    return orderRows.map((r) => r.id);
  }

  /** Pure aggregation given a settled list of order ids: section Б is one row
   *  per order with its own items; section А sums cargo per farmer ACROSS
   *  every order in the list (a farmer's produce is not tied to one order in
   *  the multi-farmer marketplace model). Takes a plain order-id array (not a
   *  scope) so overrides.excludedOrderIds can be subtracted BEFORE this runs
   *  — see getLiveRows (Task 4) — keeping farmer cargo and section Б
   *  automatically consistent with each other. */
  private async buildLiveRows(tenantId: string, orderIds: string[]): Promise<ConsolidatedProtocolRows> {
    if (orderIds.length === 0) return { farmers: [], orders: [] };

    const orderRows = await this.db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        deliveryAddress: orders.deliveryAddress,
        deliveryCity: orders.deliveryCity,
        totalStotinki: orders.totalStotinki,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, orderIds)));

    const itemRows = await this.db
      .select({
        orderId: orderItems.orderId,
        farmerId: products.farmerId,
        productName: orderItems.productName,
        variantLabel: orderItems.variantLabel,
        quantity: orderItems.quantity,
        unit: products.unit,
        priceStotinki: orderItems.priceStotinki,
      })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(inArray(orderItems.orderId, orderIds));

    const itemsByOrder = new Map<string, ProtocolItemDto[]>();
    const farmerAgg = new Map<string, Map<string, ProtocolItemDto>>();
    for (const r of itemRows) {
      if (!r.orderId) continue;
      const item: ProtocolItemDto = {
        productName: r.productName ?? '',
        variantLabel: r.variantLabel ?? undefined,
        quantity: r.quantity,
        unit: r.unit ?? undefined,
        priceStotinki: r.priceStotinki,
      } as ProtocolItemDto;
      const list = itemsByOrder.get(r.orderId) ?? [];
      list.push(item);
      itemsByOrder.set(r.orderId, list);

      if (!r.farmerId) continue;
      const perFarmer = farmerAgg.get(r.farmerId) ?? new Map<string, ProtocolItemDto>();
      const key = `${item.productName}␟${item.variantLabel ?? ''}`;
      const existing = perFarmer.get(key);
      if (existing) existing.quantity += item.quantity;
      else perFarmer.set(key, { ...item });
      farmerAgg.set(r.farmerId, perFarmer);
    }

    const orderSection: ConsolidatedOrderRow[] = orderRows.map((o) => ({
      orderId: o.id,
      orderNumber: o.orderNumber,
      customerCode: o.id.slice(0, 8).toUpperCase(),
      cityOrZone: cityFromAddress(o.deliveryAddress)?.name ?? o.deliveryCity ?? null,
      items: itemsByOrder.get(o.id) ?? [],
      totalStotinki: o.totalStotinki,
    }));

    const farmerIds = [...farmerAgg.keys()];
    const farmerMetaRows = farmerIds.length
      ? await this.db
          .select({ id: farmers.id, name: farmers.name, legal: farmers.legal, signaturePng: farmers.signaturePng })
          .from(farmers)
          .where(and(eq(farmers.tenantId, tenantId), inArray(farmers.id, farmerIds)))
      : [];
    const farmerMetaById = new Map(farmerMetaRows.map((f) => [f.id, f]));

    const farmerSection: ConsolidatedFarmerRow[] = farmerIds.map((id) => {
      const meta = farmerMetaById.get(id);
      return {
        farmerId: id,
        name: meta?.name ?? '—',
        legal: (meta?.legal as LegalIdentity | null) ?? null,
        items: [...(farmerAgg.get(id)?.values() ?? [])],
        signaturePng: decryptSignature(meta?.signaturePng ?? null),
      };
    });

    return { farmers: farmerSection, orders: orderSection };
  }
}
