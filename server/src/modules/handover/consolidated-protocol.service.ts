import {
  BadRequestException, ConflictException, forwardRef, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException,
} from '@nestjs/common';
import { and, desc, eq, inArray, isNull, lt, sql, type SQLWrapper } from 'drizzle-orm';
import {
  type Database, consolidatedProtocols, deliverySlots, farmers, orderItems, orders, products, tenants, users,
} from '@fermeribg/db';
import type {
  ConsolidatedFieldOverride,
  ConsolidatedProtocolMeta,
  ConsolidatedProtocolOverrides,
  LegalIdentity,
} from '@fermeribg/types';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { decryptSignature, encryptSignature, SignatureKeyMissingError } from '../../common/crypto/signature-crypto';
import { cityFromAddress } from './handover-city';
import type { ProtocolItemDto } from './dto/create-protocol.dto';
import { renderConsolidatedProtocolPdf } from './consolidated-pdf';
import { RoutingService } from '../routing/routing.service';
import { CourierAssignmentService } from '../routing/courier-assignment.service';
import { EmailService } from '../../common/email/email.service';

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

export interface ConsolidatedProtocolView {
  id: string;
  scope: ConsolidatedScope;
  legIndex: number | null;
  date: string;
  docNumber: number;
  status: 'draft' | 'signed';
  meta: ConsolidatedProtocolMeta;
  overrides: ConsolidatedProtocolOverrides;
  rows: ConsolidatedProtocolRows;
  receiverSignaturePng: string | null;
  signedAt: Date | null;
}

/** §4.4 "Прати на куриерите" — one row per active courier leg (never invented:
 *  sourced from CourierAssignmentService.getAssignmentsForDay). `email: null`
 *  means the courier account has no email on file — included, not omitted, so
 *  the button's recipient-preview dialog can flag it BEFORE sending. */
export interface CourierProtocolRecipient {
  legIndex: number;
  name: string;
  email: string | null;
  // Per-leg courier-email delivery state (migr 0116): 'sent' | 'failed' |
  // null(never emailed). Lets the UI show which couriers got their protocol and
  // drives „Прати на непратените" (resend only the not-yet-'sent').
  emailStatus: 'sent' | 'failed' | null;
  emailAt: Date | null;
}

/** Outcome of one courier's send attempt. Only couriers WITH an email get one
 *  of these (a no-email courier is skipped — present in `recipients`, absent
 *  from both `sent` and `failed`). */
export interface CourierProtocolSendResult {
  legIndex: number;
  email: string;
  ok: boolean;
  error?: string;
}

export interface CourierProtocolSendReport {
  recipients: CourierProtocolRecipient[];
  sent: CourierProtocolSendResult[];
  failed: CourierProtocolSendResult[];
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
    // forwardRef breaks a provider cycle that hangs NestFactory.create at DI
    // resolution: EmailService @Optional-injects PROTOCOL_ATTACHMENT_RESOLVER →
    // HandoverProtocolAttachmentResolver → ConsolidatedProtocolService →
    // EmailService. Deferring this one edge lets the graph resolve. Only used by
    // sendLegProtocolsToCouriers, so lazy resolution is fine.
    @Inject(forwardRef(() => EmailService)) private readonly email: EmailService,
  ) {}

  private readonly logger = new Logger(ConsolidatedProtocolService.name);

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

      // Prefill the fresh draft from what the system already knows (2026-07-23):
      // transport identity + Партида/Е-док carried from the latest prior
      // protocol of the same scope, plannedEnd from the day's delivery windows.
      const seed = await this.buildDraftSeed(tenantId, date, scope, legIndex);

      const [row] = await tx
        .insert(consolidatedProtocols)
        .values({
          tenantId,
          scope,
          date,
          legIndex: scope === 'leg' ? legIndex! : null,
          docNumber: (max ?? 0) + 1,
          status: 'draft',
          meta: seed.meta,
          overrides: seed.overrides,
        })
        .returning({ id: consolidatedProtocols.id });
      return row;
    });

    return { id: inserted.id };
  }

  /**
   * Best-effort prefill for a BRAND-NEW draft — „черновата да се попълва от
   * системата". Everything stays editable on the screen afterwards:
   *  - В.Транспорт identity (vehicle/plate/driverName/startPlace/startTime) is
   *    carried from the latest PRIOR protocol of the same scope (same legIndex
   *    for a leg protocol — each courier keeps their own transport).
   *  - plannedEnd comes from the day itself: the latest delivery-window end
   *    among this scope's orders; falls back to the carried value.
   *  - Партида/Е-док (`overrides.fieldOverrides['f:<farmerId>']`) carry from
   *    the same prior protocol. Only farmer keys — `o:<orderId>` corrections
   *    are order-specific and must never leak across days. `note` never
   *    carries either (day-specific by design, and absent from the PDF).
   * A prefill failure only logs — creating the draft must never be blocked by
   * a routing/Maps hiccup in resolveScopeOrderIds.
   */
  private async buildDraftSeed(
    tenantId: string,
    date: string,
    scope: ConsolidatedScope,
    legIndex?: number | null,
  ): Promise<{ meta: ConsolidatedProtocolMeta; overrides: ConsolidatedProtocolOverrides }> {
    try {
      const conds = [
        eq(consolidatedProtocols.tenantId, tenantId),
        eq(consolidatedProtocols.scope, scope),
        lt(consolidatedProtocols.date, date),
      ];
      if (scope === 'leg') conds.push(eq(consolidatedProtocols.legIndex, legIndex!));
      const [prev] = await this.db
        .select({ meta: consolidatedProtocols.meta, overrides: consolidatedProtocols.overrides })
        .from(consolidatedProtocols)
        .where(and(...conds))
        .orderBy(desc(consolidatedProtocols.date), desc(consolidatedProtocols.createdAt))
        .limit(1);

      const prevMeta = (prev?.meta as ConsolidatedProtocolMeta | null) ?? {};
      const meta: ConsolidatedProtocolMeta = {};
      for (const k of ['vehicle', 'plate', 'driverName', 'startPlace', 'startTime'] as const) {
        const v = typeof prevMeta[k] === 'string' ? prevMeta[k]!.trim() : '';
        if (v) meta[k] = v;
      }

      // plannedEnd from the actual day: the last delivery window's end.
      const ids = await this.resolveScopeOrderIds(tenantId, date, scope, legIndex);
      if (ids.length) {
        const [w] = await this.db
          .select({ max: sql<string | null>`max(${orders.deliveryWindowEnd})` })
          .from(orders)
          .where(inArray(orders.id, ids));
        if (w?.max) meta.plannedEnd = String(w.max).slice(0, 5);
      }
      if (!meta.plannedEnd && typeof prevMeta.plannedEnd === 'string' && prevMeta.plannedEnd.trim()) {
        meta.plannedEnd = prevMeta.plannedEnd.trim();
      }

      const prevOverrides = (prev?.overrides as ConsolidatedProtocolOverrides | null) ?? {};
      const fieldOverrides: Record<string, ConsolidatedFieldOverride> = {};
      for (const [key, ov] of Object.entries(prevOverrides.fieldOverrides ?? {})) {
        if (!key.startsWith('f:')) continue;
        const batch = ov?.batch?.trim();
        const eDoc = ov?.eDoc?.trim();
        if (!batch && !eDoc) continue;
        fieldOverrides[key] = { ...(batch ? { batch } : {}), ...(eDoc ? { eDoc } : {}) };
      }

      return {
        meta,
        overrides: Object.keys(fieldOverrides).length ? { fieldOverrides } : {},
      };
    } catch (err) {
      this.logger.warn(
        `draft seed failed for ${tenantId}/${date}/${scope}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { meta: {}, overrides: {} };
    }
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
        // Kept ENCRYPTED here — decrypted only at the PDF render boundary
        // (renderPdf), so a signed protocol never stores farmer signatures
        // plaintext in frozen_rows, nor returns them plaintext in the view JSON.
        signaturePng: meta?.signaturePng ?? null,
      };
    });

    return { farmers: farmerSection, orders: orderSection };
  }

  /** Live rows for a target WITH overrides applied: excludedOrderIds is
   *  subtracted from the scope's order-id set BEFORE aggregation (so farmer
   *  cargo and section Б stay consistent with each other automatically —
   *  see buildLiveRows' own doc comment), then extraRows/fieldOverrides
   *  decorate the result. Called on every read of a DRAFT protocol — nothing
   *  here is persisted until sign() freezes it (Task 5). */
  private async getLiveRows(
    tenantId: string,
    date: string,
    scope: ConsolidatedScope,
    legIndex: number | null,
    overrides: ConsolidatedProtocolOverrides,
  ): Promise<ConsolidatedProtocolRows> {
    const scopeOrderIds = await this.resolveScopeOrderIds(tenantId, date, scope, legIndex);
    const excluded = new Set(overrides.excludedOrderIds ?? []);
    const effectiveOrderIds = scopeOrderIds.filter((id) => !excluded.has(id));
    const base = await this.buildLiveRows(tenantId, effectiveOrderIds);
    return this.decorateWithOverrides(base, overrides);
  }

  private decorateWithOverrides(
    rows: ConsolidatedProtocolRows,
    overrides: ConsolidatedProtocolOverrides,
  ): ConsolidatedProtocolRows {
    const fieldOverrides = overrides.fieldOverrides ?? {};
    // Whitelist the three editable cells. Spreading the raw override object would
    // let an admin PATCH inject e.g. { name, legal, signaturePng } on a farmer or
    // { totalStotinki, customerCode } on an order and silently rewrite the
    // authoritative identity/value baked into the signed PDF.
    const pick = (o?: { batch?: string; eDoc?: string; note?: string }): { batch?: string; eDoc?: string; note?: string } => {
      const out: { batch?: string; eDoc?: string; note?: string } = {};
      if (o?.batch !== undefined) out.batch = o.batch;
      if (o?.eDoc !== undefined) out.eDoc = o.eDoc;
      if (o?.note !== undefined) out.note = o.note;
      return out;
    };
    const farmerRows = rows.farmers.map((f) => ({ ...f, ...pick(fieldOverrides[`f:${f.farmerId}`]) }));
    const orderRows = rows.orders.map((o) => ({ ...o, ...pick(fieldOverrides[`o:${o.orderId}`]) }));
    const extra = overrides.extraRows ?? [];
    const extraFarmers: ConsolidatedFarmerRow[] = extra
      .filter((r) => r.section === 'A')
      .map((r) => ({ farmerId: `extra:${r.label}`, name: r.label, legal: null, items: [], signaturePng: null, note: r.detail }));
    const extraOrders: ConsolidatedOrderRow[] = extra
      .filter((r) => r.section === 'B')
      .map((r) => ({ orderId: `extra:${r.label}`, orderNumber: null, customerCode: '—', cityOrZone: null, items: [], totalStotinki: 0, note: r.detail }));
    return { farmers: [...farmerRows, ...extraFarmers], orders: [...orderRows, ...extraOrders] };
  }

  /** Assembles the full view for one target: DRAFT reads recompute live rows
   *  (via getLiveRows) so a late order or a fresh override shows up
   *  immediately; SIGNED reads return frozen_rows byte-for-byte — the legal
   *  record from the moment of signing, untouched by anything that happens
   *  to orders afterward (see Task 5's sign()). */
  async getView(tenantId: string, id: string): Promise<ConsolidatedProtocolView> {
    const [row] = await this.db
      .select()
      .from(consolidatedProtocols)
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Протоколът не е намерен.');

    const overrides = (row.overrides as ConsolidatedProtocolOverrides) ?? {};
    const rows =
      row.status === 'signed'
        ? (row.frozenRows as ConsolidatedProtocolRows)
        : await this.getLiveRows(tenantId, row.date, row.scope as ConsolidatedScope, row.legIndex, overrides);

    return {
      id: row.id,
      scope: row.scope as ConsolidatedScope,
      legIndex: row.legIndex,
      date: row.date,
      docNumber: row.docNumber,
      status: row.status as 'draft' | 'signed',
      meta: (row.meta as ConsolidatedProtocolMeta) ?? {},
      overrides,
      rows,
      receiverSignaturePng: decryptSignature(row.receiverSignaturePng),
      signedAt: row.signedAt,
    };
  }

  /** Merges (never replaces wholesale) meta/overrides onto a DRAFT row.
   *  Rejects once the protocol is signed — an edit-after-freeze is explicitly
   *  out of scope (spec's "извън обхвата: редакция на подписан документ").
   *
   *  The merge happens IN the database (`coalesce(col,'{}') || $patch`), never
   *  as read-in-JS-then-write-whole-column: the edit screen blur-saves one
   *  field per PATCH, and two blurs land milliseconds apart (prod audit_logs
   *  showed pairs 4ms apart). With the old read-modify-write both read the
   *  same stale blob and the loser's field vanished — a whole transport form
   *  ended up as just its last field. Same idiom as common/db/jsonb.ts. */
  async updateDraft(
    tenantId: string,
    id: string,
    patch: { meta?: Partial<ConsolidatedProtocolMeta>; overrides?: Partial<ConsolidatedProtocolOverrides> },
  ): Promise<void> {
    const [row] = await this.db
      .select({ id: consolidatedProtocols.id, status: consolidatedProtocols.status })
      .from(consolidatedProtocols)
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Протоколът не е намерен.');
    if (row.status !== 'draft') throw new ConflictException('Протоколът вече е подписан — не може да се редактира.');

    const atomicMerge = (column: SQLWrapper, value: object) =>
      sql`coalesce(${column}, '{}'::jsonb) || ${JSON.stringify(value)}::jsonb`;
    await this.db
      .update(consolidatedProtocols)
      .set({
        // Only the patched column is touched — a meta PATCH must not rewrite
        // overrides (and vice versa) from any snapshot, stale or fresh.
        ...(patch.meta ? { meta: atomicMerge(consolidatedProtocols.meta, patch.meta) } : {}),
        ...(patch.overrides ? { overrides: atomicMerge(consolidatedProtocols.overrides, patch.overrides) } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(consolidatedProtocols.tenantId, tenantId),
          eq(consolidatedProtocols.id, id),
          // Belt for the status TOCTOU: a sign() landing between the check
          // above and this UPDATE makes it a no-op instead of an edit-after-freeze.
          eq(consolidatedProtocols.status, 'draft'),
        ),
      );
  }

  /** Freezes a DRAFT protocol: computes the CURRENT live rows one last time
   *  and persists them into frozen_rows, captures the transport-acceptance
   *  signature (§1.7 — a courier never has a saved one; an owner-admin who
   *  supplies none gets tenants.operatorSignaturePng auto-filled, mirroring
   *  HandoverService.createSigned's own auto-fill), flips status='signed'.
   *  Rejects a protocol that's already signed. */
  async sign(
    tenantId: string,
    id: string,
    receiverSignaturePng: string | null | undefined,
    signerRole: 'admin' | 'driver',
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(consolidatedProtocols)
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)))
      .limit(1);
    if (!row) throw new NotFoundException('Протоколът не е намерен.');
    if (row.status === 'signed') throw new ConflictException('Протоколът вече е подписан.');

    const overrides = (row.overrides as ConsolidatedProtocolOverrides) ?? {};
    const rows = await this.getLiveRows(tenantId, row.date, row.scope as ConsolidatedScope, row.legIndex, overrides);

    let sigToStore = receiverSignaturePng;
    // `== null` on purpose: the real client sends `null` (JSON.stringify keeps
    // it), never `undefined`. An owner-admin who draws nothing must still get
    // their saved tenants.operatorSignaturePng auto-filled, or the frozen legal
    // document carries an empty "Приел за транспорт" slot.
    if (sigToStore == null && signerRole === 'admin') {
      const [tenantRow] = await this.db
        .select({ operatorSignaturePng: tenants.operatorSignaturePng })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);
      sigToStore = decryptSignature(tenantRow?.operatorSignaturePng ?? null);
    }

    let encrypted: string | null = null;
    if (sigToStore) {
      try {
        encrypted = encryptSignature(sigToStore);
      } catch (e) {
        if (e instanceof SignatureKeyMissingError) {
          throw new ServiceUnavailableException('Протоколът не може да бъде подписан — липсва ключ за криптиране на сървъра.');
        }
        throw e;
      }
    }

    const signedAt = new Date();

    // Archive the rendered PDF once, now, so this signed document is served
    // byte-for-byte hereafter — immune to any later font/layout/renderer change.
    // The view mirrors exactly what getView() returns for a freshly-signed row:
    // the frozen rows (farmer signatures still ciphertext — renderPdf decrypts them
    // only at the render boundary) plus the decrypted receiver signature (sigToStore).
    // Best-effort by design: a render hiccup must never block a legal sign, so on
    // failure we persist null and getPdf() falls back to a live render. The
    // encryption key is present here (the encrypt above already succeeded).
    let pdfArchive: string | null = null;
    try {
      const signedView: ConsolidatedProtocolView = {
        id: row.id,
        scope: row.scope as ConsolidatedScope,
        legIndex: row.legIndex,
        date: row.date,
        docNumber: row.docNumber,
        status: 'signed',
        meta: (row.meta as ConsolidatedProtocolMeta) ?? {},
        overrides,
        rows,
        receiverSignaturePng: sigToStore ?? null,
        signedAt,
      };
      const buf = await this.renderPdf(tenantId, signedView);
      pdfArchive = buf.toString('base64');
    } catch (e) {
      this.logger.warn(
        `Failed to archive signed PDF for protocol ${id}; getPdf will fall back to live render. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    await this.db
      .update(consolidatedProtocols)
      .set({ status: 'signed', frozenRows: rows, receiverSignaturePng: encrypted, pdfArchive, signedAt, updatedAt: signedAt })
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)));
  }

  /** Renders a protocol to PDF. `brand` mirrors HandoverService.renderPdf's own
   *  choice — the tenant's display name, so a signed document's issuer is the
   *  same shop the operator sees everywhere else. */
  async renderPdf(tenantId: string, view: ConsolidatedProtocolView): Promise<Buffer> {
    const [tenantRow] = await this.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, tenantId)).limit(1);
    // Farmer signatures travel encrypted through the view and frozen_rows;
    // decrypt them ONLY here, at the render boundary, so plaintext biometric
    // signatures never rest in the DB nor leave in an API response.
    const renderView: ConsolidatedProtocolView = {
      ...view,
      rows: {
        ...view.rows,
        farmers: view.rows.farmers.map((f) => ({ ...f, signaturePng: decryptSignature(f.signaturePng) })),
      },
    };
    return renderConsolidatedProtocolPdf(renderView, tenantRow?.name ?? 'ФермериБГ');
  }

  /** The PDF the GET :id/pdf route serves. A SIGNED protocol returns the bytes
   *  archived at sign time (`pdf_archive`) verbatim — the legal document exactly
   *  as it was when signed, never re-rendered — so a later renderer change can't
   *  alter an already-signed record. Drafts (and any legacy signed row whose
   *  archive is null) fall through to a fresh live render. Access is enforced by
   *  the caller against `view` BEFORE this runs; the archive column is never part
   *  of a JSON view response. */
  async getPdf(tenantId: string, view: ConsolidatedProtocolView): Promise<Buffer> {
    if (view.status === 'signed') {
      const [row] = await this.db
        .select({ pdfArchive: consolidatedProtocols.pdfArchive })
        .from(consolidatedProtocols)
        .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, view.id)))
        .limit(1);
      if (row?.pdfArchive) return Buffer.from(row.pdfArchive, 'base64');
    }
    return this.renderPdf(tenantId, view);
  }

  /** The day's active-courier roster with a resolvable email, for the button's
   *  recipient PREVIEW (§4.4) — shown before anything sends. Sourced strictly
   *  from `getAssignmentsForDay` (never invented); a courier with no `users`
   *  row email comes back as `email: null`, not omitted. */
  async getCourierRecipients(tenantId: string, date: string): Promise<CourierProtocolRecipient[]> {
    const board = await this.courierAssignment.getAssignmentsForDay(tenantId, date);
    if (board.length === 0) return [];

    const accountIds = [...new Set(board.map((a) => a.accountId))];
    const userRows = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(inArray(users.id, accountIds));
    const emailById = new Map(userRows.map((u) => [u.id, u.email]));

    // Per-leg courier-email delivery state for this date (migr 0116). Only the
    // scope='leg' rows carry it; keyed by legIndex to line up with the board.
    const legRows = await this.db
      .select({
        legIndex: consolidatedProtocols.legIndex,
        status: consolidatedProtocols.courierEmailStatus,
        at: consolidatedProtocols.courierEmailAt,
      })
      .from(consolidatedProtocols)
      .where(
        and(
          eq(consolidatedProtocols.tenantId, tenantId),
          eq(consolidatedProtocols.date, date),
          eq(consolidatedProtocols.scope, 'leg'),
        ),
      );
    const stateByLeg = new Map<number, { status: 'sent' | 'failed' | null; at: Date | null }>();
    for (const r of legRows) {
      if (r.legIndex != null) {
        stateByLeg.set(r.legIndex, { status: (r.status as 'sent' | 'failed' | null) ?? null, at: r.at ?? null });
      }
    }

    return [...board]
      .sort((a, b) => a.legIndex - b.legIndex)
      .map((a) => ({
        legIndex: a.legIndex,
        name: `Лег ${a.legIndex + 1}`,
        email: emailById.get(a.accountId) ?? null,
        emailStatus: stateByLeg.get(a.legIndex)?.status ?? null,
        emailAt: stateByLeg.get(a.legIndex)?.at ?? null,
      }));
  }

  /** Button-triggered send (§4.4) — NEVER automatic, the route reorders until
   *  the last minute. For each active courier leg WITH an email: materializes
   *  (or reuses) that leg's OWN consolidated-protocol draft via `ensureDraft`,
   *  then hands a `{kind:'consolidated-protocol', consolidatedProtocolId, tenantId}`
   *  descriptor — scoped to THAT leg's id, never another leg's or the day's —
   *  to `EmailService.sendMailNow`. Direct awaited send (no queue): this is an
   *  operator-initiated, small-fanout action, not the bulk customer-email path.
   *  A courier with no email is skipped outright (present in `recipients`,
   *  absent from `sent`/`failed`); one courier's mailer failure is collected in
   *  `failed` and does not stop the others from sending. */
  async sendLegProtocolsToCouriers(
    tenantId: string,
    date: string,
    opts?: { onlyFailed?: boolean },
  ): Promise<CourierProtocolSendReport> {
    const onlyFailed = opts?.onlyFailed ?? false;
    const recipients = await this.getCourierRecipients(tenantId, date);
    const sent: CourierProtocolSendResult[] = [];
    const failed: CourierProtocolSendResult[] = [];

    for (const r of recipients) {
      if (!r.email) continue; // no email on file — skipped, not sent, not failed
      // Resend mode: never re-email a courier who already got their protocol
      // ('sent'); target only the failed / never-sent legs.
      if (onlyFailed && r.emailStatus === 'sent') continue;
      const email = r.email;
      // Resolve the leg's own protocol id up front so a mailer failure can still
      // record 'failed' on THAT leg's row (legId stays null only if ensureDraft
      // itself throws — then there's no row to mark, and we just report failed).
      let legId: string | null = null;
      try {
        legId = (await this.ensureDraft(tenantId, date, 'leg', r.legIndex)).id;
        await this.email.sendMailNow({
          to: email,
          subject: `Обобщен протокол за ${date} — ${r.name}`,
          html: `<!doctype html><html lang="bg"><body style="font-family:Arial,Helvetica,sans-serif">
<p>Здравей!</p>
<p>Прилагаме обобщения приемо-предавателен протокол за твоя курс (${r.name}) на ${date}.</p>
</body></html>`,
          attachments: [{ kind: 'consolidated-protocol', consolidatedProtocolId: legId, tenantId }],
          stream: 'transactional',
        });
        await this.markCourierEmail(tenantId, legId, 'sent', null);
        sent.push({ legIndex: r.legIndex, email, ok: true });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        if (legId) await this.markCourierEmail(tenantId, legId, 'failed', message).catch(() => undefined);
        failed.push({ legIndex: r.legIndex, email, ok: false, error: message });
      }
    }

    return { recipients, sent, failed };
  }

  /** Records the outcome of a courier-leg send on that leg's own row (migr
   *  0116), so getCourierRecipients can surface it and an onlyFailed resend can
   *  skip an already-delivered leg. */
  private async markCourierEmail(
    tenantId: string,
    id: string,
    status: 'sent' | 'failed',
    error: string | null,
  ): Promise<void> {
    await this.db
      .update(consolidatedProtocols)
      .set({ courierEmailStatus: status, courierEmailAt: new Date(), courierEmailError: error, updatedAt: new Date() })
      .where(and(eq(consolidatedProtocols.tenantId, tenantId), eq(consolidatedProtocols.id, id)));
  }
}
