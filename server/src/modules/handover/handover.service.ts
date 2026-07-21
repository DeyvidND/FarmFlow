import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
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
import { encryptSignature, decryptSignature, SignatureKeyMissingError } from '../../common/crypto/signature-crypto';

/** Statuses whose items are handover-ready — matches the prep/delivery window. */
const HANDOVER_STATUSES = ['confirmed', 'preparing'] as const;

/** Customer identity snapshotted on an order — no legal-entity data required. */
export type CustomerParty = { name?: string; phone?: string; address?: string };

/** A protocol party's legal identity widened with contact info so the PDF can print
 *  a phone/email line: farmer from `farmers.phone`/`email`, operator from the
 *  tenant's `settings.contact.phone`/`email`. Fields are omitted (never invented)
 *  when the source doesn't have them. */
export type ProtocolParty = LegalIdentity & { phone?: string; email?: string };

/** Line-item row for the farmer leg — shared by the per-target query and the bulk prefetch. */
type FarmerLegItemRow = {
  productName: string | null;
  variantLabel: string | null;
  quantity: number;
  unit: string | null;
  priceStotinki: number;
  orderNumber: number | null;
};
/** Line-item row for the customer leg — shared by the per-target query and the bulk prefetch. */
type CustomerLegItemRow = {
  productName: string | null;
  variantLabel: string | null;
  quantity: number;
  priceStotinki: number;
  unit: string | null;
  name: string | null;
};
type CustomerLegOrderRow = {
  customerName: string | null;
  customerPhone: string | null;
  deliveryAddress: string | null;
  totalStotinki: number;
  orderNumber: number | null;
};

/**
 * Reads preloaded ONCE for a whole day's targets so the bulk handover actions
 * (createBatch / signAllForDay) assemble every protocol draft in-memory instead
 * of re-issuing the operator-legal SELECT (identical every target), the farmer/order
 * SELECT and the per-order items SELECT once per target — the buildDraft N+1. Built
 * by {@link HandoverService.prefetchDraftContext}; when passed to buildDraft the
 * draft path performs zero queries.
 */
export type HandoverDraftContext = {
  operatorLegal: ProtocolParty;
  /** Operator's saved signature, decrypted once for the whole day — reused by
   *  every target so signAllForDay/createBatch never re-query per target. */
  operatorSignature: string | null;
  farmerLegalById: Map<
    string,
    {
      legal: LegalIdentity | null;
      name: string | null;
      phone: string | null;
      email: string | null;
      /** This farmer's saved signature, decrypted once for the whole day. */
      signature: string | null;
    }
  >;
  farmerItemsByKey: Map<string, FarmerLegItemRow[]>; // key = farmerLegKey(farmerId, slotId)
  customerOrderById: Map<string, CustomerLegOrderRow>;
  customerItemsByOrderId: Map<string, CustomerLegItemRow[]>;
};

/** Stable key pairing a farmer with a slot for the farmer-leg item map. */
const farmerLegKey = (farmerId: string, slotId: string) => `${farmerId}␟${slotId}`;

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

/**
 * A row in the fullscreen „Проверка" check view (Task 12) — a courier's
 * day-of-signed-protocols, shown offline (e.g. to police mid-delivery).
 * Shaped down from the raw `handover_protocols` row: only what the view
 * needs, signatures decrypted for direct `<img src>` use.
 */
export interface CheckRow {
  id: string;
  protocolNumber: number | null;
  kind: string;
  status: string;
  signedAt: Date | null;
  fromSnapshot: ProtocolParty | CustomerParty;
  toSnapshot: ProtocolParty | CustomerParty;
  items: { productName: string; variantLabel?: string; quantity: number; unit?: string }[];
  fromSignaturePng: string | null;
  toSignaturePng: string | null;
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
    ctx?: HandoverDraftContext,
  ): Promise<{
    kind: string;
    from: ProtocolParty;
    to: ProtocolParty | CustomerParty;
    items: ProtocolItemDto[];
    total: number;
    orderNumbers: number[];
    /** The farmer/operator's saved signature, decrypted — reused by createSigned
     *  to auto-fill when the sign request doesn't supply one, and by
     *  signPaperTarget/signAllForDay to decide digital vs paper. */
    savedFromSignature: string | null;
    savedToSignature: string | null;
  }> {
    if (q.kind === 'operator_to_customer') {
      return this.buildCustomerLegDraft(tenantId, q, ctx);
    }
    if (!q.farmerId || !q.slotId) {
      throw new BadRequestException('Изисква се фермер и слот.');
    }

    let operatorLegal: ProtocolParty;
    let farmerLegal: ProtocolParty;
    let rows: FarmerLegItemRow[];
    let savedFromSignature: string | null;
    let savedToSignature: string | null;
    if (ctx) {
      // Bulk path: everything was preloaded once for the whole day (no per-target query).
      operatorLegal = ctx.operatorLegal;
      const f = ctx.farmerLegalById.get(q.farmerId);
      farmerLegal = {
        ...resolveParty(f?.legal, f?.name, 'фермер'),
        phone: f?.phone ?? undefined,
        email: f?.email ?? undefined,
      };
      rows = ctx.farmerItemsByKey.get(farmerLegKey(q.farmerId, q.slotId)) ?? [];
      savedFromSignature = f?.signature ?? null;
      savedToSignature = ctx.operatorSignature ?? null;
    } else {
      const [tenantRow] = await this.db
        .select({
          legal: sql<LegalIdentity | null>`${tenants.settings}->'legal'`,
          name: tenants.name,
          contact: sql<Record<string, unknown> | null>`${tenants.settings}->'contact'`,
          operatorSignaturePng: tenants.operatorSignaturePng,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      const [farmerRow] = await this.db
        .select({
          id: farmers.id,
          legal: farmers.legal,
          name: farmers.name,
          phone: farmers.phone,
          email: farmers.email,
          signaturePng: farmers.signaturePng,
        })
        .from(farmers)
        .where(and(eq(farmers.tenantId, tenantId), eq(farmers.id, q.farmerId)))
        .limit(1);

      operatorLegal = {
        ...resolveParty(tenantRow?.legal, tenantRow?.name, 'оператор'),
        // `normalizeSiteContact` always writes a trimmed string ('' when blank, never
        // an absent key) — `??` would freeze `phone: ''` into the snapshot forever.
        // `||` omits a blank so it's left out instead of stored.
        phone: (tenantRow?.contact as any)?.phone || undefined,
        email: (tenantRow?.contact as any)?.email || undefined,
      };
      farmerLegal = {
        ...resolveParty(farmerRow?.legal, farmerRow?.name, 'фермер'),
        phone: farmerRow?.phone ?? undefined,
        email: farmerRow?.email ?? undefined,
      };
      savedFromSignature = decryptSignature(farmerRow?.signaturePng);
      savedToSignature = decryptSignature(tenantRow?.operatorSignaturePng);

      rows = await this.db
        .select({
          productName: orderItems.productName,
          variantLabel: orderItems.variantLabel,
          quantity: orderItems.quantity,
          unit: products.unit,
          // A basket („кошница") child line is stored at price 0 — the money sits on
          // the parent basket line, which belongs to no single farm. This protocol
          // records what THIS farmer physically hands over, so value it at the
          // product's own price; leaving it 0 would make the farmer sign for goods
          // the document says are worth nothing, and would understate the total.
          // Each CASE arm is cast (the repo's documented „CASE…THEN needs ::int").
          priceStotinki: sql<number>`(case when ${orderItems.bundleParentId} is not null
            then ${products.priceStotinki}::int else ${orderItems.priceStotinki}::int end)`,
          orderNumber: orders.orderNumber,
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
    }

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
    const orderNumbers = [...new Set(rows.map((r) => r.orderNumber).filter((n): n is number => n != null))].sort(
      (a, b) => a - b,
    );

    return {
      kind: q.kind,
      from: farmerLegal,
      to: operatorLegal,
      items,
      total,
      orderNumbers,
      savedFromSignature,
      savedToSignature,
    };
  }

  private async buildCustomerLegDraft(
    tenantId: string,
    q: DraftQueryDto,
    ctx?: HandoverDraftContext,
  ): Promise<{
    kind: string;
    from: ProtocolParty;
    to: CustomerParty;
    items: ProtocolItemDto[];
    total: number;
    orderNumbers: number[];
    savedFromSignature: string | null;
    savedToSignature: string | null;
  }> {
    if (!q.orderId) {
      throw new BadRequestException('Изисква се поръчка.');
    }

    let operatorLegal: ProtocolParty;
    let order: CustomerLegOrderRow;
    let rows: CustomerLegItemRow[];
    // No customer signature is ever saved/captured for this leg — only the
    // operator side can be auto-filled.
    let savedFromSignature: string | null;
    if (ctx) {
      // Bulk path: preloaded once for the whole day (no per-target query).
      operatorLegal = ctx.operatorLegal;
      savedFromSignature = ctx.operatorSignature ?? null;
      const preloaded = ctx.customerOrderById.get(q.orderId);
      if (!preloaded) {
        throw new NotFoundException('Поръчката не е намерена');
      }
      order = preloaded;
      rows = ctx.customerItemsByOrderId.get(q.orderId) ?? [];
    } else {
      const [tenantRow] = await this.db
        .select({
          legal: sql<LegalIdentity | null>`${tenants.settings}->'legal'`,
          name: tenants.name,
          contact: sql<Record<string, unknown> | null>`${tenants.settings}->'contact'`,
          operatorSignaturePng: tenants.operatorSignaturePng,
        })
        .from(tenants)
        .where(eq(tenants.id, tenantId))
        .limit(1);

      operatorLegal = {
        ...resolveParty(tenantRow?.legal, tenantRow?.name, 'оператор'),
        // `normalizeSiteContact` always writes a trimmed string ('' when blank, never
        // an absent key) — `??` would freeze `phone: ''` into the snapshot forever.
        // `||` omits a blank so it's left out instead of stored.
        phone: (tenantRow?.contact as any)?.phone || undefined,
        email: (tenantRow?.contact as any)?.email || undefined,
      };
      savedFromSignature = decryptSignature(tenantRow?.operatorSignaturePng);

      const [dbOrder] = await this.db
        .select({
          customerName: orders.customerName,
          customerPhone: orders.customerPhone,
          deliveryAddress: orders.deliveryAddress,
          totalStotinki: orders.totalStotinki,
          orderNumber: orders.orderNumber,
        })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), eq(orders.id, q.orderId)))
        .limit(1);

      if (!dbOrder) {
        throw new NotFoundException('Поръчката не е намерена');
      }
      order = dbOrder;

      rows = await this.db
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
    }

    const to: CustomerParty = {
      name: order.customerName ?? undefined,
      phone: order.customerPhone ?? undefined,
      address: order.deliveryAddress ?? undefined,
    };

    const items: ProtocolItemDto[] = rows.map((r) => ({
      productName: r.productName ?? r.name ?? '',
      variantLabel: r.variantLabel ?? undefined,
      quantity: r.quantity,
      priceStotinki: r.priceStotinki,
      unit: r.unit ?? undefined,
    }));

    const orderNumbers = order.orderNumber != null ? [order.orderNumber] : [];

    return {
      kind: q.kind,
      from: operatorLegal,
      to,
      items,
      total: order.totalStotinki,
      orderNumbers,
      savedFromSignature,
      savedToSignature: null,
    };
  }

  /**
   * Preload every read buildDraft needs for a whole day's targets in a fixed number
   * of set-based queries (operator legal once; all farmers' legal via one inArray;
   * all farmer-leg items in one grouped join over the slots; all customer orders +
   * their items via inArray on the order ids). Passed to buildDraft so the
   * createBatch / signAllForDay loops assemble each draft in-memory instead of
   * fanning out ~3 SELECTs per target (the buildDraft N+1). Constant DB work
   * regardless of how many orders/farmers the day has.
   */
  private async prefetchDraftContext(
    tenantId: string,
    farmerIds: string[],
    slotIds: string[],
    orderIds: string[],
  ): Promise<HandoverDraftContext> {
    const [tenantRow] = await this.db
      .select({
        legal: sql<LegalIdentity | null>`${tenants.settings}->'legal'`,
        name: tenants.name,
        contact: sql<Record<string, unknown> | null>`${tenants.settings}->'contact'`,
        operatorSignaturePng: tenants.operatorSignaturePng,
      })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    const operatorLegal: ProtocolParty = {
      ...resolveParty(tenantRow?.legal, tenantRow?.name, 'оператор'),
      // `normalizeSiteContact` always writes a trimmed string ('' when blank, never
      // an absent key) — `??` would freeze `phone: ''` into the snapshot forever.
      // `||` omits a blank so it's left out instead of stored.
      phone: (tenantRow?.contact as any)?.phone || undefined,
      email: (tenantRow?.contact as any)?.email || undefined,
    };
    const operatorSignature = decryptSignature(tenantRow?.operatorSignaturePng);

    const farmerLegalById = new Map<
      string,
      { legal: LegalIdentity | null; name: string | null; phone: string | null; email: string | null; signature: string | null }
    >();
    if (farmerIds.length > 0) {
      const rows = await this.db
        .select({
          id: farmers.id,
          legal: farmers.legal,
          name: farmers.name,
          phone: farmers.phone,
          email: farmers.email,
          signaturePng: farmers.signaturePng,
        })
        .from(farmers)
        .where(and(eq(farmers.tenantId, tenantId), inArray(farmers.id, farmerIds)));
      for (const f of rows) {
        farmerLegalById.set(f.id, {
          legal: f.legal,
          name: f.name,
          phone: f.phone,
          email: f.email,
          signature: decryptSignature(f.signaturePng),
        });
      }
    }

    const farmerItemsByKey = new Map<string, FarmerLegItemRow[]>();
    if (farmerIds.length > 0 && slotIds.length > 0) {
      const rows = await this.db
        .select({
          farmerId: products.farmerId,
          slotId: orders.slotId,
          productName: orderItems.productName,
          variantLabel: orderItems.variantLabel,
          quantity: orderItems.quantity,
          unit: products.unit,
          // A basket („кошница") child line is stored at price 0 — the money sits on
          // the parent basket line, which belongs to no single farm. This protocol
          // records what THIS farmer physically hands over, so value it at the
          // product's own price; leaving it 0 would make the farmer sign for goods
          // the document says are worth nothing, and would understate the total.
          // Each CASE arm is cast (the repo's documented „CASE…THEN needs ::int").
          priceStotinki: sql<number>`(case when ${orderItems.bundleParentId} is not null
            then ${products.priceStotinki}::int else ${orderItems.priceStotinki}::int end)`,
          orderNumber: orders.orderNumber,
        })
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
      for (const r of rows) {
        if (!r.farmerId || !r.slotId) continue;
        const key = farmerLegKey(r.farmerId, r.slotId);
        const list = farmerItemsByKey.get(key) ?? [];
        list.push({
          productName: r.productName,
          variantLabel: r.variantLabel,
          quantity: r.quantity,
          unit: r.unit,
          priceStotinki: r.priceStotinki,
          orderNumber: r.orderNumber,
        });
        farmerItemsByKey.set(key, list);
      }
    }

    const customerOrderById = new Map<string, CustomerLegOrderRow>();
    const customerItemsByOrderId = new Map<string, CustomerLegItemRow[]>();
    if (orderIds.length > 0) {
      const orderRows = await this.db
        .select({
          id: orders.id,
          customerName: orders.customerName,
          customerPhone: orders.customerPhone,
          deliveryAddress: orders.deliveryAddress,
          totalStotinki: orders.totalStotinki,
          orderNumber: orders.orderNumber,
        })
        .from(orders)
        .where(and(eq(orders.tenantId, tenantId), inArray(orders.id, orderIds)));
      for (const o of orderRows) {
        customerOrderById.set(o.id, {
          customerName: o.customerName,
          customerPhone: o.customerPhone,
          deliveryAddress: o.deliveryAddress,
          totalStotinki: o.totalStotinki,
          orderNumber: o.orderNumber,
        });
      }
      const itemRows = await this.db
        .select({
          orderId: orderItems.orderId,
          productName: orderItems.productName,
          variantLabel: orderItems.variantLabel,
          quantity: orderItems.quantity,
          priceStotinki: orderItems.priceStotinki,
          unit: products.unit,
          name: products.name,
        })
        .from(orderItems)
        .leftJoin(products, eq(orderItems.productId, products.id))
        .where(inArray(orderItems.orderId, orderIds));
      for (const r of itemRows) {
        if (r.orderId == null) continue; // rows come from inArray(orderId, …) → always set; guard for the type
        const list = customerItemsByOrderId.get(r.orderId) ?? [];
        list.push({
          productName: r.productName,
          variantLabel: r.variantLabel,
          quantity: r.quantity,
          priceStotinki: r.priceStotinki,
          unit: r.unit,
          name: r.name,
        });
        customerItemsByOrderId.set(r.orderId, list);
      }
    }

    return { operatorLegal, operatorSignature, farmerLegalById, farmerItemsByKey, customerOrderById, customerItemsByOrderId };
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

    // Auto-fill from the saved signature when the DTO omits one (the "one tap"
    // handover) — encrypted here, right before insert; never stored in plaintext.
    // The saved source can only be non-null if ENCRYPTION_KEY was configured when
    // it was decrypted just above, so this can only throw when the CLIENT supplied
    // a fresh signature and no key is configured right now. Translated into a clean
    // 503 (not a raw crash) — same pattern as FarmersService.setSignature /
    // TenantsService.setSignature. Computed before the duplicate check/transaction
    // so a misconfigured key fails fast, without burning an advisory lock or a
    // protocol number on a doomed insert.
    // `undefined` (key omitted) → fall back to the saved signature (one-tap flow).
    // Explicit `null` → the party declined to sign («Получено без подпис») and that
    // must be honoured, NOT coalesced onto the saved signature — `??` would treat
    // both the same and silently stamp a saved signature onto a protocol the party
    // explicitly refused to sign.
    const fromSig = dto.fromSignaturePng !== undefined ? dto.fromSignaturePng : (draft.savedFromSignature ?? null);
    const toSig = dto.toSignaturePng !== undefined ? dto.toSignaturePng : (draft.savedToSignature ?? null);
    let fromSignaturePng: string | null;
    let toSignaturePng: string | null;
    try {
      fromSignaturePng = fromSig ? encryptSignature(fromSig) : null;
      toSignaturePng = toSig ? encryptSignature(toSig) : null;
    } catch (e) {
      if (e instanceof SignatureKeyMissingError) {
        throw new ServiceUnavailableException(
          'Протоколът не може да бъде подписан — липсва ключ за криптиране на сървъра.',
        );
      }
      throw e;
    }
    // 'digital' means both required parties actually have a stored signature — either
    // freshly drawn or auto-filled from a saved one. If either side ends up with none
    // (explicitly declined, or omitted with no saved signature to fall back to), this
    // is not a fully digitally-signed protocol; label it 'paper' rather than
    // misrepresenting a missing signature as digital. (Unlike signPaperTarget/
    // signAllForDay, the customer leg here CAN capture a live signature via the
    // dialog's pad, so there is no per-kind exemption — both sides are held to the
    // same standard.)
    const signMode = fromSig && toSig ? 'digital' : 'paper';

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
      // Authoritative duplicate-target guard, re-run INSIDE the lock. The pre-lock
      // check above is only a fast-path: two concurrent signs for the same target can
      // both pass it (neither insert is committed yet), then serialize on this
      // per-tenant advisory lock. The loser now sees the winner's committed row and
      // aborts. Without this, the advisory lock guards only the NUMBER, and — since
      // there is no DB unique constraint on the target — two signed protocols for one
      // handover would be created with distinct numbers (double-counted totals/PDF).
      const [dupe] = await tx
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
      if (dupe) throw new ConflictException('Протокол вече е издаден за това предаване.');

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
          fromSignaturePng,
          toSignaturePng,
          meta: { ...(dto.meta ?? {}), orderNumbers: draft.orderNumbers },
          signMode,
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

    // Preload every read buildDraft needs for the whole day ONCE, so the per-target
    // loop assembles each draft in-memory instead of fanning out ~3 SELECTs per target.
    const ctxFarmerIds = [
      ...new Set(targets.flatMap((t) => (t.kind === 'farmer_to_operator' ? [t.farmerId] : []))),
    ];
    const ctxOrderIds = targets.flatMap((t) => (t.kind === 'operator_to_customer' ? [t.orderId] : []));
    const draftCtx = await this.prefetchDraftContext(tenantId, ctxFarmerIds, slotIds, ctxOrderIds);

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
        draft = await this.buildDraft(tenantId, target as DraftQueryDto, draftCtx);
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
        // Re-check the target INSIDE the lock (the pre-lock check above is a fast-path):
        // a concurrent batch/sign for the same target serializes here, so its committed
        // row is now visible → skip instead of creating a duplicate protocol for it.
        const [dupe] = await tx
          .select({ id: handoverProtocols.id })
          .from(handoverProtocols)
          .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.kind, target.kind), targetMatch))
          .limit(1);
        if (dupe) return null;
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
            meta: { orderNumbers: draft.orderNumbers },
            signMode: 'pending',
            status: 'draft',
          })
          .returning({ id: handoverProtocols.id });
        return row;
      });

      if (!inserted) continue; // a concurrent writer already created this target's protocol
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
      // Re-check the target INSIDE the lock (the pre-lock check above is a fast-path): a
      // concurrent create/sign for this target serializes here, so return its committed
      // row instead of inserting a duplicate (there is no DB unique on the target).
      const [dupe] = await tx
        .select({ id: handoverProtocols.id })
        .from(handoverProtocols)
        .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.kind, dto.kind), targetMatch))
        .limit(1);
      if (dupe) return dupe;
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
          meta: { orderNumbers: draft.orderNumbers },
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
  async signPaperTarget(
    tenantId: string,
    dto: DraftQueryDto,
    ctx?: HandoverDraftContext,
  ): Promise<{ id: string }> {
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

    const draft = await this.buildDraft(tenantId, dto, ctx);
    // Auto-sign digitally when a saved signature exists for the leg — otherwise
    // this virtual-target sign stays a bare paper record (no PNG). A customer
    // never has a saved signature (none is ever captured for that party), so the
    // customer leg only needs the operator's saved signature to count as digital.
    // Re-encrypting `savedFromSignature`/`savedToSignature` here can't hit a
    // missing-key error: those two columns (farmers.signaturePng /
    // tenants.operatorSignaturePng) never hold legacy plaintext — their own
    // setSignature always refuses to store unencrypted — so a non-null decrypted
    // value here proves ENCRYPTION_KEY is configured right now, same process.
    const fromSig = draft.savedFromSignature ?? null;
    const toSig = draft.savedToSignature ?? null;
    const digital = !!(fromSig && (dto.kind === 'operator_to_customer' || toSig));
    const inserted = await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${tenantId}, 0))`);
      // Re-check the target INSIDE the lock (the pre-lock check above is a fast-path): a
      // concurrent create/sign for this target serializes here, so return its committed
      // row instead of inserting a duplicate (there is no DB unique on the target).
      const [dupe] = await tx
        .select({ id: handoverProtocols.id })
        .from(handoverProtocols)
        .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.kind, dto.kind), targetMatch))
        .limit(1);
      if (dupe) return dupe;
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
          fromSignaturePng: fromSig ? encryptSignature(fromSig) : null,
          toSignaturePng: toSig ? encryptSignature(toSig) : null,
          meta: { orderNumbers: draft.orderNumbers },
          signMode: digital ? 'digital' : 'paper',
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
   * The day's SIGNED protocols for the fullscreen „Проверка" view (Task 12) — a
   * courier stopped mid-delivery (e.g. by police) shows these fast, often
   * offline. Reuses `list()`, which already `leftJoin`s `deliverySlots` for
   * the date filter (`handover_protocols` has no date column of its own — see
   * `list()`'s doc comment). Only `status === 'signed'` rows qualify; a
   * draft/pending protocol is not something to present as evidence. Signatures
   * are decrypted here (unlike `list()`'s raw rows) so the client can render
   * them straight into an `<img src>`, and each row is reshaped to only the
   * fields the check view needs — no price/order-number/raw-column leakage.
   * `list()` already issues a bounded number of queries; decryption below is
   * pure in-memory work, so this adds no per-row query.
   */
  async listForCheck(
    tenantId: string,
    q: { date?: string; slotId?: string },
    /**
     * Driver scope. When present, only protocols covering one of THESE orders are
     * returned — the goods actually in this courier's van. Omitted for the owner,
     * who sees the whole day.
     *
     * This is a PII boundary, not a convenience filter: a protocol carries the
     * counterparty's name and address, so a tenant-wide list would hand every
     * courier the customer details of deliveries they are not making. Both link
     * columns are checked — `orderId` for an operator→customer receipt, and the
     * `orderIds` array for a farmer→operator pickup that covers several orders.
     */
    onlyOrderIds?: ReadonlySet<string>,
  ): Promise<CheckRow[]> {
    const rows = (await this.list(tenantId, { slotId: q.slotId, date: q.date })) as Array<
      typeof handoverProtocols.$inferSelect
    >;
    const inScope = (r: (typeof rows)[number]) => {
      if (!onlyOrderIds) return true;
      if (r.orderId && onlyOrderIds.has(r.orderId)) return true;
      return (r.orderIds ?? []).some((id) => onlyOrderIds.has(id));
    };
    return rows
      .filter((r) => r.status === 'signed')
      .filter(inScope)
      .sort((a, b) => (a.protocolNumber ?? 0) - (b.protocolNumber ?? 0))
      .map((r) => ({
        id: r.id,
        protocolNumber: r.protocolNumber,
        kind: r.kind,
        status: r.status,
        signedAt: r.signedAt ?? null,
        fromSnapshot: r.fromSnapshot as ProtocolParty | CustomerParty,
        toSnapshot: r.toSnapshot as ProtocolParty | CustomerParty,
        items: ((r.items as ProtocolItemDto[] | null) ?? []).map((i) => ({
          productName: i.productName,
          variantLabel: i.variantLabel ?? undefined,
          quantity: i.quantity,
          unit: i.unit ?? undefined,
        })),
        fromSignaturePng: decryptSignature(r.fromSignaturePng),
        toSignaturePng: decryptSignature(r.toSignaturePng),
      }));
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

  /** Loads a single protocol scoped to the tenant; 404s if missing. Signatures
   *  come back DECRYPTED — the client/PDF renderer must never receive a blob it
   *  can't use. */
  async getById(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(handoverProtocols)
      .where(and(eq(handoverProtocols.tenantId, tenantId), eq(handoverProtocols.id, id)))
      .limit(1);

    if (!row) {
      throw new NotFoundException('Протоколът не е намерен.');
    }
    return {
      ...row,
      fromSignaturePng: decryptSignature(row.fromSignaturePng),
      toSignaturePng: decryptSignature(row.toSignaturePng),
    };
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
      meta: { orderNumbers: draft.orderNumbers },
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

    // Preload buildDraft's reads for the whole day ONCE so signPaperTarget assembles
    // each draft in-memory instead of re-querying tenant/farmer/order/items per target.
    const ctxFarmerIds = [
      ...new Set(targets.flatMap((t) => (t.kind === 'farmer_to_operator' && t.farmerId ? [t.farmerId] : []))),
    ];
    const ctxOrderIds = targets.flatMap((t) => (t.kind === 'operator_to_customer' && t.orderId ? [t.orderId] : []));
    const draftCtx = await this.prefetchDraftContext(tenantId, ctxFarmerIds, slotIds, ctxOrderIds);

    let signed = 0;
    for (const t of targets) {
      try {
        await this.signPaperTarget(tenantId, t, draftCtx);
        signed++;
      } catch {
        // Already signed, or a target that can't be built (e.g. no name anywhere) —
        // skip it, don't abort the whole run.
      }
    }
    return { signed };
  }
}
