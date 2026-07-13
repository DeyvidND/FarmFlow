import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, getTableColumns, inArray, sql } from 'drizzle-orm';
import {
  type Database,
  deliverySlots,
  farmers,
  handoverProtocols,
  orderItems,
  orders,
  products,
  tenants,
} from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import type { DraftQueryDto } from './dto/draft-query.dto';
import type { CreateProtocolDto, ProtocolItemDto } from './dto/create-protocol.dto';
import type { BatchDto } from './dto/batch.dto';
import { resolveParty, type LegalIdentity } from './legal.util';
import { renderProtocolPdf } from './handover-pdf';
import { mergePdfs } from '../econt/econt.mappers';

/** Statuses whose items are handover-ready — matches the prep/delivery window. */
const HANDOVER_STATUSES = ['confirmed', 'preparing'] as const;

/** Customer identity snapshotted on an order — no legal-entity data required. */
export type CustomerParty = { name?: string; phone?: string; address?: string };

/**
 * A row in the day's live protocol view. A persisted protocol has a real `id`
 * and number; a not-yet-created (virtual) target has `id: null`,
 * `protocolNumber: null` and `status: 'draft'`.
 */
export interface DayProtocolRow {
  id: string | null;
  kind: string;
  farmerId: string | null;
  orderId: string | null;
  slotId: string | null;
  protocolNumber: number | null;
  status: string;
  signMode: string;
  totalStotinki: number;
  createdAt: Date | string | null;
  fromSnapshot: LegalIdentity | CustomerParty | null;
  toSnapshot: LegalIdentity | CustomerParty | null;
}

/** Target key so a live-computed target lines up with its persisted row. */
function protocolKey(r: { kind: string; orderId: string | null; farmerId: string | null; slotId: string | null }): string {
  return r.kind === 'operator_to_customer' ? `o:${r.orderId}` : `f:${r.farmerId}:${r.slotId}`;
}

/** A not-yet-persisted protocol for a live target. */
function virtualRow(
  kind: 'farmer_to_operator' | 'operator_to_customer',
  slotId: string | undefined,
  opts: {
    farmerId?: string;
    orderId?: string;
    from: LegalIdentity | CustomerParty;
    to: LegalIdentity | CustomerParty;
  },
): DayProtocolRow {
  return {
    id: null,
    kind,
    farmerId: opts.farmerId ?? null,
    orderId: opts.orderId ?? null,
    slotId: slotId ?? null,
    protocolNumber: null,
    status: 'draft',
    signMode: 'pending',
    totalStotinki: 0,
    createdAt: null,
    fromSnapshot: opts.from,
    toSnapshot: opts.to,
  };
}

/**
 * Builds an unsaved handover-protocol draft: the two parties (frozen at draft
 * time) plus the line items. `farmer_to_operator` aggregates one farmer's
 * items across a slot; `operator_to_customer` uses a single order's own
 * lines (no cross-farmer aggregation) with the customer as the `to` party.
 */
@Injectable()
export class HandoverService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async buildDraft(
    tenantId: string,
    q: DraftQueryDto,
  ): Promise<{
    kind: string;
    from: LegalIdentity;
    to: LegalIdentity | CustomerParty;
    items: ProtocolItemDto[];
    total: number;
  }> {
    if (q.kind === 'operator_to_customer') {
      return this.buildCustomerLegDraft(tenantId, q);
    }
    if (!q.farmerId || !q.slotId) {
      throw new BadRequestException('Изисква се фермер и слот.');
    }

    const [tenantRow] = await this.db
      .select({ legal: sql<LegalIdentity | null>`${tenants.settings}->'legal'`, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const [farmerRow] = await this.db
      .select({ id: farmers.id, legal: farmers.legal, name: farmers.name })
      .from(farmers)
      .where(and(eq(farmers.tenantId, tenantId), eq(farmers.id, q.farmerId)))
      .limit(1);

    const operatorLegal = resolveParty(tenantRow?.legal, tenantRow?.name, 'оператор');
    const farmerLegal = resolveParty(farmerRow?.legal, farmerRow?.name, 'фермер');

    const rows: {
      productName: string | null;
      variantLabel: string | null;
      quantity: number;
      unit: string | null;
      priceStotinki: number;
    }[] = await this.db
      .select({
        productName: orderItems.productName,
        variantLabel: orderItems.variantLabel,
        quantity: orderItems.quantity,
        unit: products.unit,
        priceStotinki: orderItems.priceStotinki,
      })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(products.farmerId, q.farmerId),
          eq(orders.tenantId, tenantId),
          eq(orders.slotId, q.slotId),
          inArray(orders.status, [...HANDOVER_STATUSES]),
        ),
      );

    // Group by (productName, variantLabel): sum quantity, keep the first unit/price.
    const byKey = new Map<string, ProtocolItemDto>();
    for (const r of rows) {
      const key = `${r.productName ?? ''}␟${r.variantLabel ?? ''}`;
      const existing = byKey.get(key);
      if (existing) {
        existing.quantity += r.quantity;
      } else {
        byKey.set(key, {
          productName: r.productName ?? '',
          variantLabel: r.variantLabel ?? undefined,
          quantity: r.quantity,
          unit: r.unit ?? undefined,
          priceStotinki: r.priceStotinki,
          orderNumber: undefined,
        });
      }
    }

    const items = [...byKey.values()];
    const total = items.reduce((s, i) => s + i.quantity * i.priceStotinki, 0);

    return { kind: q.kind, from: farmerLegal, to: operatorLegal, items, total };
  }

  private async buildCustomerLegDraft(
    tenantId: string,
    q: DraftQueryDto,
  ): Promise<{ kind: string; from: LegalIdentity; to: CustomerParty; items: ProtocolItemDto[]; total: number }> {
    if (!q.orderId) {
      throw new BadRequestException('Изисква се поръчка.');
    }

    const [tenantRow] = await this.db
      .select({ legal: sql<LegalIdentity | null>`${tenants.settings}->'legal'`, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const operatorLegal = resolveParty(tenantRow?.legal, tenantRow?.name, 'оператор');

    const [order] = await this.db
      .select({
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        deliveryAddress: orders.deliveryAddress,
        totalStotinki: orders.totalStotinki,
      })
      .from(orders)
      .where(and(eq(orders.tenantId, tenantId), eq(orders.id, q.orderId)))
      .limit(1);

    if (!order) {
      throw new NotFoundException('Поръчката не е намерена');
    }

    const to: CustomerParty = {
      name: order.customerName ?? undefined,
      phone: order.customerPhone ?? undefined,
      address: order.deliveryAddress ?? undefined,
    };

    const rows: {
      productName: string | null;
      variantLabel: string | null;
      quantity: number;
      priceStotinki: number;
      unit: string | null;
      name: string | null;
    }[] = await this.db
      .select({
        productName: orderItems.productName,
        variantLabel: orderItems.variantLabel,
        quantity: orderItems.quantity,
        priceStotinki: orderItems.priceStotinki,
        unit: products.unit,
        name: products.name,
      })
      .from(orderItems)
      .leftJoin(products, eq(orderItems.productId, products.id))
      .where(eq(orderItems.orderId, q.orderId));

    const items: ProtocolItemDto[] = rows.map((r) => ({
      productName: r.productName ?? r.name ?? '',
      variantLabel: r.variantLabel ?? undefined,
      quantity: r.quantity,
      priceStotinki: r.priceStotinki,
      unit: r.unit ?? undefined,
    }));

    return { kind: q.kind, from: operatorLegal, to, items, total: order.totalStotinki };
  }

  /**
   * Signs and freezes a handover protocol. Re-derives `from`/`to`/`items`/`total`
   * via `buildDraft` (client-supplied item totals are never trusted), assigns the
   * next per-tenant `protocol_number`, and rejects a duplicate signed protocol for
   * the same `(tenant, kind, farmer|order, slot)` target.
   */
  async createSigned(
    tenantId: string,
    dto: CreateProtocolDto,
  ): Promise<{ id: string; protocolNumber: number }> {
    const draft = await this.buildDraft(tenantId, dto);

    const targetMatch =
      dto.kind === 'operator_to_customer'
        ? eq(handoverProtocols.orderId, dto.orderId!)
        : and(eq(handoverProtocols.farmerId, dto.farmerId!), eq(handoverProtocols.slotId, dto.slotId!));

    const [existing] = await this.db
      .select({ id: handoverProtocols.id })
      .from(handoverProtocols)
      .where(
        and(
          eq(handoverProtocols.tenantId, tenantId),
          eq(handoverProtocols.kind, dto.kind),
          eq(handoverProtocols.status, 'signed'),
          targetMatch,
        ),
      )
      .limit(1);

    if (existing) {
      throw new ConflictException('Протокол вече е издаден за това предаване.');
    }

    // Next per-tenant protocol number. The advisory lock serializes concurrent
    // signings/batches for this tenant so two protocols can't claim the same
    // number; it's released when the transaction commits/rolls back — same
    // pattern as orders.service.ts's order-number assignment.
    const inserted = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
      const [{ max }] = await tx
        .select({ max: sql<number | null>`max(${handoverProtocols.protocolNumber})` })
        .from(handoverProtocols)
        .where(eq(handoverProtocols.tenantId, tenantId));

      const next = (max ?? 0) + 1;

      const [row] = await tx
        .insert(handoverProtocols)
        .values({
          tenantId,
          kind: dto.kind,
          farmerId: dto.farmerId,
          orderId: dto.orderId,
          slotId: dto.slotId,
          protocolNumber: next,
          fromSnapshot: draft.from,
          toSnapshot: draft.to,
          items: draft.items,
          orderIds: dto.orderId ? [dto.orderId] : null,
          totalStotinki: draft.total,
          fromSignaturePng: dto.fromSignaturePng,
          toSignaturePng: dto.toSignaturePng,
          meta: dto.meta ?? null,
          signMode: 'digital',
          status: 'signed',
          signedAt: new Date(),
        })
        .returning({ id: handoverProtocols.id, protocolNumber: handoverProtocols.protocolNumber });
      return row;
    });

    return { id: inserted.id, protocolNumber: inserted.protocolNumber! };
  }

  /**
   * Creates one `pending` (draft/paper) protocol per handover-ready target for a
   * slot/day: a farmer-pickup leg for each distinct farmer with confirmed/preparing
   * items in that slot, plus a customer-delivery leg for each such order. Idempotent —
   * a target already covered by a protocol row of ANY status (draft or signed) is
   * skipped, so re-running after some protocols are signed only fills in the gaps.
   */
  async createBatch(
    tenantId: string,
    b: BatchDto,
  ): Promise<{
    ids: string[];
    skipped: { kind: string; farmerId?: string; orderId?: string; slotId?: string; reason: string }[];
  }> {
    const slotIds = await this.resolveSlotIds(tenantId, b);
    if (slotIds.length === 0) {
      return { ids: [], skipped: [] };
    }

    const farmerRows: { farmerId: string | null; slotId: string | null }[] = await this.db
      .select({ farmerId: products.farmerId, slotId: orders.slotId })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.slotId, slotIds),
          inArray(orders.status, [...HANDOVER_STATUSES]),
        ),
      );

    const customerOrders: { id: string; slotId: string | null }[] = await this.db
      .select({ id: orders.id, slotId: orders.slotId })
      .from(orders)
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.slotId, slotIds),
          inArray(orders.status, [...HANDOVER_STATUSES]),
        ),
      );

    type Target =
      | { kind: 'farmer_to_operator'; farmerId: string; slotId: string }
      | { kind: 'operator_to_customer'; orderId: string; slotId?: string };

    const farmerTargets = [
      ...new Map(
        farmerRows
          .filter((r): r is { farmerId: string; slotId: string } => !!r.farmerId && !!r.slotId)
          .map((r): [string, Target] => [
            `${r.farmerId}␟${r.slotId}`,
            { kind: 'farmer_to_operator', farmerId: r.farmerId, slotId: r.slotId },
          ]),
      ).values(),
    ];

    const customerTargets: Target[] = customerOrders.map((o) => ({
      kind: 'operator_to_customer',
      orderId: o.id,
      slotId: o.slotId ?? undefined,
    }));

    // «Печат фермери» / «Печат поръчки» narrow to one leg; absent = both.
    const targets = [
      ...(b.kind === 'operator_to_customer' ? [] : farmerTargets),
      ...(b.kind === 'farmer_to_operator' ? [] : customerTargets),
    ];
    const ids: string[] = [];
    const skipped: { kind: string; farmerId?: string; orderId?: string; slotId?: string; reason: string }[] = [];
    if (targets.length === 0) {
      return { ids, skipped };
    }

    for (const target of targets) {
      const targetMatch =
        target.kind === 'operator_to_customer'
          ? eq(handoverProtocols.orderId, target.orderId)
          : and(eq(handoverProtocols.farmerId, target.farmerId), eq(handoverProtocols.slotId, target.slotId));

      const [existing] = await this.db
        .select({ id: handoverProtocols.id })
        .from(handoverProtocols)
        .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.kind, target.kind), targetMatch))
        .limit(1);

      if (existing) {
        continue;
      }

      // A missing legal identity (operator or, for a farmer leg, that farmer)
      // must only skip THIS target, not abort the whole batch — otherwise one
      // farmer who hasn't filled in their legal data yet blocks every other
      // farmer's and every customer's protocol for the day.
      let draft: Awaited<ReturnType<HandoverService['buildDraft']>>;
      try {
        draft = await this.buildDraft(tenantId, target as DraftQueryDto);
      } catch (e) {
        skipped.push({
          kind: target.kind,
          farmerId: target.kind === 'farmer_to_operator' ? target.farmerId : undefined,
          orderId: target.kind === 'operator_to_customer' ? target.orderId : undefined,
          slotId: target.slotId,
          reason: e instanceof Error ? e.message : 'Неуспешно генериране на протокол.',
        });
        continue;
      }

      // Next per-tenant protocol number, re-queried per target (not hoisted
      // before the loop) under an advisory lock — same race-safe pattern as
      // createSigned, so this loop, a concurrent batch call, and a concurrent
      // createSigned can't ever claim the same number.
      const inserted = await this.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
        const [{ max }] = await tx
          .select({ max: sql<number | null>`max(${handoverProtocols.protocolNumber})` })
          .from(handoverProtocols)
          .where(eq(handoverProtocols.tenantId, tenantId));
        const nextNumber = (max ?? 0) + 1;

        const [row] = await tx
          .insert(handoverProtocols)
          .values({
            tenantId,
            kind: target.kind,
            farmerId: target.kind === 'farmer_to_operator' ? target.farmerId : undefined,
            orderId: target.kind === 'operator_to_customer' ? target.orderId : undefined,
            slotId: target.slotId,
            protocolNumber: nextNumber,
            fromSnapshot: draft.from,
            toSnapshot: draft.to,
            items: draft.items,
            orderIds: target.kind === 'operator_to_customer' ? [target.orderId] : null,
            totalStotinki: draft.total,
            signMode: 'pending',
            status: 'draft',
          })
          .returning({ id: handoverProtocols.id });
        return row;
      });

      ids.push(inserted.id);
    }

    return { ids, skipped };
  }

  /** Resolves the slot ids in scope for a batch request: the slot itself if
   *  given, else every slot on the given date. */
  private async resolveSlotIds(tenantId: string, b: BatchDto): Promise<string[]> {
    if (b.slotId) {
      return [b.slotId];
    }
    if (!b.date) {
      throw new BadRequestException('Изисква се слот или дата.');
    }
    const rows: { id: string }[] = await this.db
      .select({ id: deliverySlots.id })
      .from(deliverySlots)
      .where(and(eq(deliverySlots.tenantId, tenantId), eq(deliverySlots.date, b.date)));
    return rows.map((r) => r.id);
  }

  /** Flips a `draft`/`pending` protocol to `signed` via a paper (in-person)
   *  signature — no signature images captured, unlike `createSigned`'s digital
   *  path. Rejects a protocol that's already signed. */
  async markSigned(tenantId: string, id: string): Promise<void> {
    const [row] = await this.db
      .select({ id: handoverProtocols.id, status: handoverProtocols.status })
      .from(handoverProtocols)
      .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.id, id)))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Протоколът не е намерен.');
    }
    if (row.status === 'signed') {
      throw new ConflictException('Протоколът вече е подписан.');
    }

    await this.db
      .update(handoverProtocols)
      .set({ status: 'signed', signMode: 'paper', signedAt: new Date() })
      .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.id, id)));
  }

  /** Ensures a persisted (numbered) draft exists for a single target — used when
   *  a virtual day-view row's own PDF is opened: downloading a protocol means
   *  materializing it, so it prints WITH a number. Returns the existing row's id
   *  if one is already there, otherwise builds + numbers + inserts a `draft`. */
  async ensureDraftTarget(tenantId: string, dto: DraftQueryDto): Promise<{ id: string }> {
    const targetMatch =
      dto.kind === 'operator_to_customer'
        ? eq(handoverProtocols.orderId, dto.orderId!)
        : and(eq(handoverProtocols.farmerId, dto.farmerId!), eq(handoverProtocols.slotId, dto.slotId!));

    const [existing] = await this.db
      .select({ id: handoverProtocols.id })
      .from(handoverProtocols)
      .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.kind, dto.kind), targetMatch))
      .limit(1);

    if (existing) {
      return { id: existing.id };
    }

    const draft = await this.buildDraft(tenantId, dto);
    const inserted = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
      const [{ max }] = await tx
        .select({ max: sql<number | null>`max(${handoverProtocols.protocolNumber})` })
        .from(handoverProtocols)
        .where(eq(handoverProtocols.tenantId, tenantId));
      const [row] = await tx
        .insert(handoverProtocols)
        .values({
          tenantId,
          kind: dto.kind,
          farmerId: dto.farmerId,
          orderId: dto.orderId,
          slotId: dto.slotId,
          protocolNumber: (max ?? 0) + 1,
          fromSnapshot: draft.from,
          toSnapshot: draft.to,
          items: draft.items,
          orderIds: dto.orderId ? [dto.orderId] : null,
          totalStotinki: draft.total,
          signMode: 'pending',
          status: 'draft',
        })
        .returning({ id: handoverProtocols.id });
      return row;
    });
    return { id: inserted.id };
  }

  /** Paper-signs a single target from the day view. If a protocol row already
   *  exists for the target it's flipped to signed(paper); otherwise a draft is
   *  built, numbered (advisory lock, same race-safe path as createSigned) and
   *  inserted straight as signed(paper). This is how a virtual (id=null) row gets
   *  signed on paper — a number is assigned only now, at sign time. */
  async signPaperTarget(tenantId: string, dto: DraftQueryDto): Promise<{ id: string }> {
    const targetMatch =
      dto.kind === 'operator_to_customer'
        ? eq(handoverProtocols.orderId, dto.orderId!)
        : and(eq(handoverProtocols.farmerId, dto.farmerId!), eq(handoverProtocols.slotId, dto.slotId!));

    const [existing] = await this.db
      .select({ id: handoverProtocols.id, status: handoverProtocols.status })
      .from(handoverProtocols)
      .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.kind, dto.kind), targetMatch))
      .limit(1);

    if (existing) {
      if (existing.status === 'signed') {
        throw new ConflictException('Протоколът вече е подписан.');
      }
      await this.db
        .update(handoverProtocols)
        .set({ status: 'signed', signMode: 'paper', signedAt: new Date() })
        .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.id, existing.id)));
      return { id: existing.id };
    }

    const draft = await this.buildDraft(tenantId, dto);
    const inserted = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
      const [{ max }] = await tx
        .select({ max: sql<number | null>`max(${handoverProtocols.protocolNumber})` })
        .from(handoverProtocols)
        .where(eq(handoverProtocols.tenantId, tenantId));
      const [row] = await tx
        .insert(handoverProtocols)
        .values({
          tenantId,
          kind: dto.kind,
          farmerId: dto.farmerId,
          orderId: dto.orderId,
          slotId: dto.slotId,
          protocolNumber: (max ?? 0) + 1,
          fromSnapshot: draft.from,
          toSnapshot: draft.to,
          items: draft.items,
          orderIds: dto.orderId ? [dto.orderId] : null,
          totalStotinki: draft.total,
          signMode: 'paper',
          status: 'signed',
          signedAt: new Date(),
        })
        .returning({ id: handoverProtocols.id });
      return row;
    });
    return { id: inserted.id };
  }

  /** Lists protocols for a tenant, optionally narrowed by slot and/or kind.
   *  `handover_protocols` has no date column of its own; when a `date` is given
   *  without a `slotId` to scope it precisely, this joins `deliverySlots` (via
   *  the protocol's `slotId`) and filters on `deliverySlots.date` — the actual
   *  calendar date, unlike a UTC `createdAt` range which drifts against the
   *  Europe/Sofia dates `BatchDto.date` documents (see task-7 report). */
  async list(tenantId: string, q: { slotId?: string; date?: string; kind?: string }) {
    const conditions = [eq(handoverProtocols.tenantId, tenantId)];
    if (q.slotId) {
      conditions.push(eq(handoverProtocols.slotId, q.slotId));
    }
    if (q.kind) {
      conditions.push(eq(handoverProtocols.kind, q.kind));
    }
    if (q.date && !q.slotId) {
      conditions.push(eq(deliverySlots.date, q.date));
      return this.db
        .select({ ...getTableColumns(handoverProtocols) })
        .from(handoverProtocols)
        .leftJoin(deliverySlots, eq(handoverProtocols.slotId, deliverySlots.id))
        .where(and(...conditions));
    }
    return this.db
      .select()
      .from(handoverProtocols)
      .where(and(...conditions));
  }

  /**
   * The day's protocols as a LIVE view: every handover-ready target for the
   * slot/day (a farmer pickup per farmer with confirmed/preparing items, a
   * customer delivery per such order) merged with any already-persisted
   * `handover_protocols` rows. Targets without a persisted row come back as
   * virtual rows (`id: null`, `protocolNumber: null`, `status: 'draft'`) so the
   * list is populated without «Печат за деня» first — a protocol row + its number
   * are created only when it's printed or signed. Persisted rows keep their id /
   * status / number. A persisted row whose target no longer appears (e.g. its
   * order was cancelled after signing) is still returned, so signed history is
   * never dropped.
   */
  async listForDay(
    tenantId: string,
    q: { slotId?: string; date?: string },
  ): Promise<DayProtocolRow[]> {
    const slotIds = await this.resolveSlotIds(tenantId, q);
    if (slotIds.length === 0) {
      return [];
    }

    const farmerRows: { farmerId: string | null; slotId: string | null }[] = await this.db
      .select({ farmerId: products.farmerId, slotId: orders.slotId })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          inArray(orders.slotId, slotIds),
          inArray(orders.status, [...HANDOVER_STATUSES]),
        ),
      );

    const customerOrders: { id: string; slotId: string | null; customerName: string | null }[] =
      await this.db
        .select({ id: orders.id, slotId: orders.slotId, customerName: orders.customerName })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            inArray(orders.slotId, slotIds),
            inArray(orders.status, [...HANDOVER_STATUSES]),
          ),
        );

    const farmerTargets = [
      ...new Map(
        farmerRows
          .filter((r): r is { farmerId: string; slotId: string } => !!r.farmerId && !!r.slotId)
          .map((r): [string, { farmerId: string; slotId: string }] => [
            `f:${r.farmerId}:${r.slotId}`,
            { farmerId: r.farmerId, slotId: r.slotId },
          ]),
      ).values(),
    ];

    // Already-persisted rows for this slot/day, keyed by the same target key.
    const persisted = (await this.list(tenantId, { slotId: q.slotId, date: q.date })) as DayProtocolRow[];
    const persistedByKey = new Map<string, DayProtocolRow>();
    for (const r of persisted) {
      persistedByKey.set(protocolKey(r), r);
    }

    // Party names — one query each, so building virtual rows costs no per-target
    // round-trips. The operator (tenant) and farmers always have a display name;
    // resolveParty falls back to it when the legal identity is unset.
    const [tenantRow] = await this.db
      .select({ legal: sql<LegalIdentity | null>`${tenants.settings}->'legal'`, name: tenants.name })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const operatorParty = resolveParty(tenantRow?.legal, tenantRow?.name, 'оператор');

    const farmerIds = [...new Set(farmerTargets.map((t) => t.farmerId))];
    const farmerById = new Map<string, { legal: LegalIdentity | null; name: string | null }>();
    if (farmerIds.length > 0) {
      const rows: { id: string; legal: LegalIdentity | null; name: string | null }[] = await this.db
        .select({ id: farmers.id, legal: farmers.legal, name: farmers.name })
        .from(farmers)
        .where(and(eq(farmers.tenantId, tenantId), inArray(farmers.id, farmerIds)));
      for (const f of rows) farmerById.set(f.id, { legal: f.legal, name: f.name });
    }

    const out: DayProtocolRow[] = [];
    const consumed = new Set<string>();

    for (const t of farmerTargets) {
      const key = `f:${t.farmerId}:${t.slotId}`;
      const hit = persistedByKey.get(key);
      if (hit) {
        out.push(hit);
        consumed.add(key);
        continue;
      }
      const f = farmerById.get(t.farmerId);
      out.push(
        virtualRow('farmer_to_operator', t.slotId, {
          farmerId: t.farmerId,
          from: resolveParty(f?.legal, f?.name, 'фермер'),
          to: operatorParty,
        }),
      );
    }

    for (const o of customerOrders) {
      const key = `o:${o.id}`;
      const hit = persistedByKey.get(key);
      if (hit) {
        out.push(hit);
        consumed.add(key);
        continue;
      }
      out.push(
        virtualRow('operator_to_customer', o.slotId ?? undefined, {
          orderId: o.id,
          from: operatorParty,
          to: { name: o.customerName ?? '—' },
        }),
      );
    }

    // Persisted rows whose target dropped out of the live set (e.g. a cancelled
    // order) — keep them so a signed protocol never disappears from the day.
    for (const [key, r] of persistedByKey) {
      if (!consumed.has(key)) out.push(r);
    }

    return out;
  }

  /** Loads a single protocol scoped to the tenant; 404s if missing. */
  async getById(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(handoverProtocols)
      .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.id, id)))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Протоколът не е намерен.');
    }
    return row;
  }

  /** Renders a single protocol (tenant-scoped) to a PDF buffer. */
  async renderPdf(tenantId: string, id: string): Promise<Buffer> {
    const row = await this.getById(tenantId, id);
    return renderProtocolPdf(row);
  }

  /** Renders a single target's protocol to PDF on the fly WITHOUT persisting it —
   *  used to print/preview a virtual (not-yet-created) row from the day view. No
   *  protocol number is assigned (it's not a saved document yet). */
  async renderPreviewPdf(tenantId: string, q: DraftQueryDto): Promise<Buffer> {
    const draft = await this.buildDraft(tenantId, q);
    return renderProtocolPdf({
      kind: draft.kind,
      protocolNumber: null,
      createdAt: new Date(),
      signedAt: null,
      fromSnapshot: draft.from,
      toSnapshot: draft.to,
      items: draft.items,
      totalStotinki: draft.total,
      fromSignaturePng: null,
      toSignaturePng: null,
    });
  }

  /** Renders every protocol matching the slot/date (via `list`) to PDF and
   *  merges them into one buffer. Throws if the slot/date has no protocols —
   *  an empty merged PDF (0 pages) would be a useless download. */
  async renderBatchPdf(tenantId: string, b: BatchDto): Promise<Buffer> {
    const rows = await this.list(tenantId, { slotId: b.slotId, date: b.date, kind: b.kind });
    if (rows.length === 0) {
      throw new BadRequestException('Няма протоколи за тази дата.');
    }
    const pdfs = await Promise.all(rows.map((row) => renderProtocolPdf(row)));
    return mergePdfs(pdfs);
  }

  /**
   * Paper-signs EVERY handover-ready target for the day at once («Отбележи всички
   * подписани») — narrowed to one leg by `b.kind` if given. Each target is routed
   * through `signPaperTarget` (create+number+sign a virtual one, flip an existing
   * draft); already-signed targets and any that can't be built are skipped, so the
   * bulk action never aborts on one bad row. Returns how many were newly signed.
   */
  async signAllForDay(tenantId: string, b: BatchDto): Promise<{ signed: number }> {
    const slotIds = await this.resolveSlotIds(tenantId, b);
    if (slotIds.length === 0) {
      return { signed: 0 };
    }

    const targets: DraftQueryDto[] = [];

    if (b.kind !== 'operator_to_customer') {
      const farmerRows: { farmerId: string | null; slotId: string | null }[] = await this.db
        .select({ farmerId: products.farmerId, slotId: orders.slotId })
        .from(orderItems)
        .innerJoin(products, eq(products.id, orderItems.productId))
        .innerJoin(orders, eq(orders.id, orderItems.orderId))
        .where(
          and(
            eq(orders.tenantId, tenantId),
            inArray(orders.slotId, slotIds),
            inArray(orders.status, [...HANDOVER_STATUSES]),
          ),
        );
      const seen = new Set<string>();
      for (const r of farmerRows) {
        if (!r.farmerId || !r.slotId) continue;
        const key = `${r.farmerId}:${r.slotId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ kind: 'farmer_to_operator', farmerId: r.farmerId, slotId: r.slotId });
      }
    }

    if (b.kind !== 'farmer_to_operator') {
      const customerOrders: { id: string; slotId: string | null }[] = await this.db
        .select({ id: orders.id, slotId: orders.slotId })
        .from(orders)
        .where(
          and(
            eq(orders.tenantId, tenantId),
            inArray(orders.slotId, slotIds),
            inArray(orders.status, [...HANDOVER_STATUSES]),
          ),
        );
      for (const o of customerOrders) {
        targets.push({ kind: 'operator_to_customer', orderId: o.id, slotId: o.slotId ?? undefined });
      }
    }

    let signed = 0;
    for (const t of targets) {
      try {
        await this.signPaperTarget(tenantId, t);
        signed++;
      } catch {
        // Already signed, or a target that can't be built (e.g. no name anywhere) —
        // skip it, don't abort the whole run.
      }
    }
    return { signed };
  }
}
