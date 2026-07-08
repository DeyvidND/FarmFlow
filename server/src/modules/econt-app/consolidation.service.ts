import { Injectable, Inject, BadRequestException, ConflictException } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { type Database, orders, shipments, farmers, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { consolidateCourierEnabled, type DeliveryConfig } from '../orders/delivery-pricing';
import { farmerDeliveryNamespace } from '../orders/courier-eligibility';
import {
  groupConsolidationCandidates, planConsolidation, resolveCollectorCarrier,
  ConsolidationError, type CandidateRow, type SuggestionGroup, type MemberState,
} from './consolidation.helpers';

@Injectable()
export class ConsolidationService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  private async loadDeliveryCfg(tenantId: string): Promise<DeliveryConfig | null> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return (row?.settings as { delivery?: DeliveryConfig } | null)?.delivery ?? null;
  }

  /** Candidate = tenant's unshipped courier draft shipments, joined to their order + farmer. */
  private async loadCandidates(tenantId: string): Promise<CandidateRow[]> {
    return this.db
      .select({
        shipmentId: shipments.id,
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        farmerId: orders.farmerId,
        farmerName: farmers.name,
        totalStotinki: orders.totalStotinki,
        customerName: orders.customerName,
        customerPhone: orders.customerPhone,
        deliveryCity: orders.deliveryCity,
        deliveryAddress: orders.deliveryAddress,
        visitorHash: orders.visitorHash,
      })
      .from(shipments)
      .innerJoin(orders, eq(shipments.orderId, orders.id))
      .leftJoin(farmers, eq(orders.farmerId, farmers.id))
      .where(
        and(
          eq(shipments.tenantId, tenantId),
          eq(shipments.status, 'draft'),
          isNull(shipments.consolidationGroupId),
          eq(orders.deliveryType, 'courier'),
          sql`${orders.status} <> 'cancelled'`,
          sql`${orders.farmerId} is not null`,
        ),
      ) as unknown as Promise<CandidateRow[]>;
  }

  async getToggle(tenantId: string): Promise<{ enabled: boolean }> {
    return { enabled: consolidateCourierEnabled(await this.loadDeliveryCfg(tenantId)) };
  }

  /**
   * Deep-merge only the consolidateCourier flag into settings.delivery, preserving
   * sibling keys. `jsonb_set` alone is unsafe here: with a 2-level path it is a no-op
   * when the intermediate `delivery` object is absent, so build the merge with `||`
   * (concatenation) at each level instead.
   */
  async setToggle(tenantId: string, enabled: boolean): Promise<{ enabled: boolean }> {
    await this.db
      .update(tenants)
      .set({
        settings: sql`coalesce(${tenants.settings}, '{}'::jsonb) || jsonb_build_object(
          'delivery',
          coalesce(${tenants.settings} -> 'delivery', '{}'::jsonb)
            || jsonb_build_object('consolidateCourier', to_jsonb(${enabled}))
        )`,
      })
      .where(eq(tenants.id, tenantId));
    return { enabled };
  }

  async getSuggestions(tenantId: string): Promise<{ suggestions: SuggestionGroup[] }> {
    if (!consolidateCourierEnabled(await this.loadDeliveryCfg(tenantId))) return { suggestions: [] };
    const rows = await this.loadCandidates(tenantId);
    return { suggestions: groupConsolidationCandidates(rows) };
  }

  async consolidate(
    tenantId: string,
    input: { collectorFarmerId: string; memberOrderIds: string[]; carrier?: 'econt' | 'speedy' },
  ) {
    const cfg = await this.loadDeliveryCfg(tenantId);
    if (!consolidateCourierEnabled(cfg)) throw new BadRequestException('Обединяването не е включено.');

    try {
      // Load member orders + their draft shipments (tenant-scoped).
      const rows = await this.db
        .select({
          shipmentId: shipments.id,
          orderId: orders.id,
          farmerId: orders.farmerId,
          farmerName: farmers.name,
          status: shipments.status,
          consolidationGroupId: shipments.consolidationGroupId,
          econtNo: shipments.econtShipmentNumber,
          trackingNo: shipments.trackingNumber,
          totalStotinki: orders.totalStotinki,
        })
        .from(orders)
        .innerJoin(shipments, eq(shipments.orderId, orders.id))
        .leftJoin(farmers, eq(orders.farmerId, farmers.id))
        .where(
          and(
            eq(orders.tenantId, tenantId),
            inArray(orders.id, input.memberOrderIds),
            eq(orders.deliveryType, 'courier'),
          ),
        );
      if (rows.length !== input.memberOrderIds.length) {
        throw new ConsolidationError('Някоя от поръчките не е намерена или не е куриерска.');
      }

      const members: MemberState[] = rows.map((r) => ({
        shipmentId: r.shipmentId,
        orderId: r.orderId,
        farmerId: r.farmerId as string,
        status: r.status,
        hasWaybill: !!(r.econtNo || r.trackingNo),
        consolidationGroupId: r.consolidationGroupId,
        totalStotinki: r.totalStotinki,
      }));

      const plan = planConsolidation(members, input.collectorFarmerId);
      const ns = farmerDeliveryNamespace(
        (await this.loadSettings(tenantId)),
        input.collectorFarmerId,
      );
      const carrier = resolveCollectorCarrier(ns, input.carrier);

      await this.db.transaction(async (tx) => {
        // Compare-and-set: re-assert the preconditions checked above (draft, not yet
        // in a group) at write time, so a concurrent consolidate/waybill-creation call
        // that raced past the pre-check can't also write — the loser aborts the tx.
        const masterClaimed = await tx
          .update(shipments)
          .set({
            consolidationGroupId: plan.masterShipmentId,
            codAmountStotinki: plan.codSumStotinki,
            carrier,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(shipments.id, plan.masterShipmentId),
              eq(shipments.status, 'draft'),
              isNull(shipments.consolidationGroupId),
            ),
          )
          .returning({ id: shipments.id });
        if (masterClaimed.length === 0) {
          throw new ConflictException('Една от пратките е променена междувременно — опитайте отново.');
        }
        if (plan.childShipmentIds.length) {
          const childrenClaimed = await tx
            .update(shipments)
            .set({
              consolidationGroupId: plan.masterShipmentId,
              status: 'consolidated',
              updatedAt: new Date(),
            })
            .where(
              and(
                inArray(shipments.id, plan.childShipmentIds),
                eq(shipments.status, 'draft'),
                isNull(shipments.consolidationGroupId),
              ),
            )
            .returning({ id: shipments.id });
          if (childrenClaimed.length !== plan.childShipmentIds.length) {
            throw new ConflictException('Една от пратките е променена междувременно — опитайте отново.');
          }
        }
      });

      const breakdown = rows
        .map((r) => ({ farmerId: r.farmerId as string, farmerName: r.farmerName, totalStotinki: r.totalStotinki }));
      return { masterShipmentId: plan.masterShipmentId, carrier, breakdown, sumStotinki: plan.codSumStotinki };
    } catch (err) {
      if (err instanceof ConsolidationError) throw new BadRequestException(err.message);
      throw err;
    }
  }

  async unconsolidate(tenantId: string, masterShipmentId: string): Promise<{ restored: number }> {
    const [master] = await this.db
      .select({
        id: shipments.id,
        groupId: shipments.consolidationGroupId,
        econtNo: shipments.econtShipmentNumber,
        trackingNo: shipments.trackingNumber,
        orderId: shipments.orderId,
      })
      .from(shipments)
      .where(and(eq(shipments.id, masterShipmentId), eq(shipments.tenantId, tenantId)))
      .limit(1);
    if (!master || master.groupId !== master.id) {
      throw new BadRequestException('Пратката не е обединена.');
    }
    if (master.econtNo || master.trackingNo) {
      throw new BadRequestException('Товарителницата вече е създадена — не може да се раздели.');
    }
    // Reset master COD to its own order total (its collector share) via codAmountFor rules:
    // an unpaid COD order's total; the update below reuses the order total directly.
    const [ord] = await this.db
      .select({ total: orders.totalStotinki, method: orders.paymentMethod, paidAt: orders.paidAt })
      .from(orders)
      .where(eq(orders.id, master.orderId as string))
      .limit(1);
    const ownCod = ord && ord.method === 'cod' && !ord.paidAt ? ord.total : null;

    const restored = await this.db.transaction(async (tx) => {
      // The WHERE here (consolidationGroupId = masterShipmentId) is itself the
      // compare-and-set for children: a concurrent unconsolidate would already have
      // cleared it, so this simply matches zero rows — no separate guard needed.
      const children = await tx
        .update(shipments)
        .set({ consolidationGroupId: null, status: 'draft', updatedAt: new Date() })
        .where(and(eq(shipments.consolidationGroupId, masterShipmentId), sql`${shipments.id} <> ${masterShipmentId}`))
        .returning({ id: shipments.id });
      // Compare-and-set on the master: re-assert it's still a master (not already
      // unconsolidated by a concurrent call) and still has no waybill, at write time.
      const masterClaimed = await tx
        .update(shipments)
        .set({ consolidationGroupId: null, codAmountStotinki: ownCod, updatedAt: new Date() })
        .where(
          and(
            eq(shipments.id, masterShipmentId),
            eq(shipments.consolidationGroupId, masterShipmentId),
            isNull(shipments.econtShipmentNumber),
            isNull(shipments.trackingNumber),
          ),
        )
        .returning({ id: shipments.id });
      if (masterClaimed.length === 0) {
        throw new ConflictException('Една от пратките е променена междувременно — опитайте отново.');
      }
      return children.length;
    });
    return { restored };
  }

  private async loadSettings(tenantId: string): Promise<unknown> {
    const [row] = await this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return row?.settings ?? null;
  }
}
