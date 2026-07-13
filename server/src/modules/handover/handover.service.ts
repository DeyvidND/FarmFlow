import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type Database, farmers, orderItems, orders, products, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import type { DraftQueryDto } from './dto/draft-query.dto';
import type { ProtocolItemDto } from './dto/create-protocol.dto';
import { requireLegal, type LegalIdentity } from './legal.util';

/** Statuses whose items are handover-ready — matches the prep/delivery window. */
const HANDOVER_STATUSES = ['confirmed', 'preparing'] as const;

/** Customer identity snapshotted on an order — no legal-entity data required. */
export type CustomerParty = { name?: string; phone?: string; address?: string };

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
      .select({ legal: sql<LegalIdentity | null>`${tenants.settings}->'legal'` })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const [farmerRow] = await this.db
      .select({ id: farmers.id, legal: farmers.legal })
      .from(farmers)
      .where(and(eq(farmers.tenantId, tenantId), eq(farmers.id, q.farmerId)))
      .limit(1);

    const operatorLegal = requireLegal(tenantRow?.legal, 'оператор');
    const farmerLegal = requireLegal(farmerRow?.legal, 'фермер');

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
      .select({ legal: sql<LegalIdentity | null>`${tenants.settings}->'legal'` })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const operatorLegal = requireLegal(tenantRow?.legal, 'оператор');

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
}
