import { Inject, Injectable } from '@nestjs/common';
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import {
  type Database,
  manualExpenses,
  orderItems,
  orders,
  routeCourierAssignments,
  tenants,
  users,
} from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { bgDateTz, bgToday } from '../../common/time/bg-time';
import { resolveWindow, type StatsRangeTag } from './stats.service';
import { readInfoCommissionBps } from './stats.settings';
import { buildPnl, type PnlAccountRow, type PnlExpenseRow, type PnlResult } from './pnl.util';

export type PnlResponse = PnlResult & { from: string; to: string; range: StatsRangeTag };

/**
 * „Приходи / разходи / печалба" за Статистика. Базата на деня е `deliveredAt`
 * (БГ ден): куриер печели само когато е доставил, а недоставена поръчка няма
 * ден на доставка. Нарочно НЕ се кешира — ключът е за прозорец и не може да се
 * изброи при запис на разход, а собственикът трябва да вижда въведеното веднага.
 */
@Injectable()
export class PnlService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async pnl(
    tenantId: string,
    opts: { range?: string; from?: string; to?: string } = {},
  ): Promise<PnlResponse> {
    const { from, to, range } = resolveWindow(opts, bgToday());

    // Стоките на поръчка се сумират в подзаявка. Иначе join-ът към редовете
    // размножава `orders.total_stotinki` по броя артикули и доставката излиза
    // няколкократно завишена. Построена като СУРОВ SQL (не `this.db.select(...).as(...)`)
    // нарочно: a typed Subquery embeds live Column↔Table objects that carry a
    // circular back-reference (`column.table.columns[...] === column`), which is
    // fine for driving real Postgres but breaks any inspection of the rendered
    // fragment that walks it naively (e.g. JSON.stringify). Raw identifiers are
    // fixed literals defined right here, never user input — no injection risk.
    const itemsSub = sql`(select ${orderItems.orderId} as order_id, sum(${orderItems.quantity} * ${orderItems.priceStotinki}) as items from ${orderItems} group by ${orderItems.orderId}) as order_items_sum`;

    // `deliveredAt` е timestamptz → ЕДНА конверсия (bgDateTz). Двойната
    // конверсия на bgDate() тук би изместила деня.
    const deliveredDay = bgDateTz(orders.deliveredAt);

    const revenueP = this.db
      .select({
        accountId: routeCourierAssignments.accountId,
        itemsStotinki: sql<number>`coalesce(sum(coalesce(${sql.raw('order_items_sum.items')}, 0)), 0)::int`,
        deliveryStotinki: sql<number>`coalesce(sum(greatest(0, ${sql.raw('orders.total_stotinki')} - coalesce(${sql.raw('order_items_sum.items')}, 0))), 0)::int`,
      })
      .from(orders)
      .leftJoin(itemsSub, sql`${sql.raw('order_items_sum.order_id')} = ${orders.id}`)
      // Кой е карал тази лента в деня на доставката. `date` в дъската е text
      // 'YYYY-MM-DD', затова датата се форматира, вместо да се кастне.
      .leftJoin(
        routeCourierAssignments,
        and(
          eq(routeCourierAssignments.tenantId, orders.tenantId),
          eq(routeCourierAssignments.date, sql`to_char(${deliveredDay}, 'YYYY-MM-DD')`),
          eq(routeCourierAssignments.legIndex, orders.courierIndex),
        ),
      )
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'delivered'),
          // `deliveredDay` is a derived SQL expression, not a real Column, so
          // `gte`/`lte` can't type-detect it to auto-bind the right side as a
          // Param (drizzle's bindIfParam only wraps when the left side is a real
          // driver-value-encoding Column). `sql.param(...)` binds explicitly.
          sql`${deliveredDay} >= ${sql.param(from)}::date`,
          sql`${deliveredDay} <= ${sql.param(to)}::date`,
        ),
      )
      // Един ред на акаунт — `buildPnl` разчита на това и не слива дубликати.
      .groupBy(routeCourierAssignments.accountId);

    const expensesP = this.db
      .select({
        accountId: manualExpenses.courierAccountId,
        category: manualExpenses.category,
        amountStotinki: sql<number>`coalesce(sum(${manualExpenses.amountStotinki}), 0)::int`,
      })
      .from(manualExpenses)
      .where(
        and(
          eq(manualExpenses.tenantId, tenantId),
          gte(manualExpenses.date, from),
          lte(manualExpenses.date, to),
        ),
      )
      .groupBy(manualExpenses.courierAccountId, manualExpenses.category);

    const settingsP = this.db
      .select({ settings: tenants.settings })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const [revenueRows, expenseRows, settingsRows] = await Promise.all([revenueP, expensesP, settingsP]);

    const ids = [
      ...new Set(
        [...revenueRows, ...expenseRows]
          .map((r) => r.accountId)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ];
    // inArray, не ANY() — драйверът не сериализира ANY() коректно тук.
    const nameRows = ids.length
      ? await this.db
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(eq(users.tenantId, tenantId), inArray(users.id, ids)))
      : [];
    const names: Record<string, string> = {};
    for (const n of nameRows) names[n.id] = n.email;

    const commissionBps = readInfoCommissionBps(settingsRows[0]?.settings ?? null);
    const result = buildPnl(
      revenueRows as PnlAccountRow[],
      expenseRows as PnlExpenseRow[],
      commissionBps,
      names,
    );
    return { ...result, from, to, range };
  }
}
