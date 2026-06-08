import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { type Database, orders, orderItems, products, deliverySlots, tenants } from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { bgToday, bgDate } from '../../common/time/bg-time';

interface DigestOrder {
  id: string;
  deliveryType: string;
  customerName: string | null;
  deliveryAddress: string | null;
  deliveryCity: string | null;
  econtOffice: string | null;
  slotFrom: string | null;
  slotTo: string | null;
}

interface FarmerItem {
  productName: string;
  quantity: number;
}

interface FarmerOrder extends DigestOrder {
  items: FarmerItem[];
}

/** Where an Econt order goes — office (office method) or door (city + street). */
function econtDestination(o: DigestOrder): string {
  if (o.deliveryType === 'econt_address') {
    const parts = [o.deliveryCity, o.deliveryAddress].filter(Boolean).join(', ');
    return `до адрес: ${parts || '—'}`;
  }
  return `офис: ${o.econtOffice ?? '—'}`;
}

export interface DigestSummary {
  selfDeliveryCount: number;
  econtCount: number;
  totalOrders: number;
  distinctCustomers: number;
}

export interface DigestResult {
  html: string;
  text: string;
  summary: DigestSummary;
}

function hhmm(t: string | null): string {
  return t ? t.slice(0, 5) : '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(date: string, addressOrders: DigestOrder[], econtOrders: DigestOrder[]): string {
  const totalOrders = addressOrders.length + econtOrders.length;
  const distinctCustomers = new Set(
    [...addressOrders, ...econtOrders].map((o) => o.customerName?.trim().toLowerCase()),
  ).size;

  const addressRows = addressOrders
    .map((o) => {
      const slot =
        o.slotFrom && o.slotTo
          ? `${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}`
          : '—';
      return `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.customerName ?? '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.deliveryAddress ?? '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${slot}</td>
        </tr>`;
    })
    .join('');

  const econtRows = econtOrders
    .map(
      (o) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.customerName ?? '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(econtDestination(o))}</td>
        </tr>`,
    )
    .join('');

  const addressSection =
    addressOrders.length > 0
      ? `
      <h2 style="font-size:16px;color:#333;margin:24px 0 8px">Доставка до адрес (${addressOrders.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Клиент</th>
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Адрес</th>
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Час</th>
          </tr>
        </thead>
        <tbody>${addressRows}</tbody>
      </table>`
      : '';

  const econtSection =
    econtOrders.length > 0
      ? `
      <h2 style="font-size:16px;color:#333;margin:24px 0 8px">Еконт — за изпращане (${econtOrders.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Клиент</th>
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Дестинация</th>
          </tr>
        </thead>
        <tbody>${econtRows}</tbody>
      </table>`
      : '';

  return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Доставки за ${date}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">
    Доставки за ${date}
  </h1>
  <p style="font-size:14px;color:#555">
    Общо поръчки: <strong>${totalOrders}</strong> &nbsp;|&nbsp;
    До адрес: <strong>${addressOrders.length}</strong> &nbsp;|&nbsp;
    Еконт: <strong>${econtOrders.length}</strong> &nbsp;|&nbsp;
    Уникални клиенти: <strong>${distinctCustomers}</strong>
  </p>
  ${addressSection}
  ${econtSection}
  <p style="font-size:12px;color:#999;margin-top:32px">FarmFlow — автоматичен дайджест</p>
</body>
</html>`;
}

function renderText(date: string, addressOrders: DigestOrder[], econtOrders: DigestOrder[]): string {
  const lines: string[] = [`Доставки за ${date}`, ''];
  lines.push(`Общо: ${addressOrders.length + econtOrders.length} поръчки`);
  lines.push('');

  if (addressOrders.length > 0) {
    lines.push(`Доставка до адрес (${addressOrders.length}):`);
    for (const o of addressOrders) {
      const slot = o.slotFrom && o.slotTo ? ` [${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}]` : '';
      lines.push(`  • ${o.customerName ?? '—'} — ${o.deliveryAddress ?? '—'}${slot}`);
    }
    lines.push('');
  }

  if (econtOrders.length > 0) {
    lines.push(`Еконт — за изпращане (${econtOrders.length}):`);
    for (const o of econtOrders) {
      lines.push(`  • ${o.customerName ?? '—'} — ${econtDestination(o)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderFarmerHtml(
  date: string,
  farmerName: string,
  prep: FarmerItem[],
  addressOrders: FarmerOrder[],
  econtOrders: FarmerOrder[],
  pickupOrders: FarmerOrder[],
): string {
  const prepRows = prep
    .map(
      (p) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(p.productName)}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right"><strong>${p.quantity}</strong> бр</td>
        </tr>`,
    )
    .join('');

  const orderBlock = (o: FarmerOrder, dest: string): string => {
    const itemLines = o.items
      .map((it) => `<li>${escapeHtml(it.productName)} — <strong>${it.quantity}</strong> бр</li>`)
      .join('');
    return `
      <div style="margin:0 0 12px;padding:10px 12px;border:1px solid #eee;border-radius:8px">
        <div style="font-weight:bold">${escapeHtml(o.customerName ?? '—')}</div>
        <div style="font-size:13px;color:#555">${escapeHtml(dest)}</div>
        <ul style="margin:6px 0 0;padding-left:18px;font-size:14px">${itemLines}</ul>
      </div>`;
  };

  const pickupSection =
    pickupOrders.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">За вземане (${pickupOrders.length})</h2>` +
        pickupOrders.map((o) => orderBlock(o, 'За вземане на място')).join('')
      : '';

  const addressSection =
    addressOrders.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Доставка до адрес (${addressOrders.length})</h2>` +
        addressOrders
          .map((o) => {
            const slot = o.slotFrom && o.slotTo ? ` · ${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}` : '';
            return orderBlock(o, `${o.deliveryAddress ?? '—'}${slot}`);
          })
          .join('')
      : '';

  const econtSection =
    econtOrders.length > 0
      ? `<h2 style="font-size:16px;color:#333;margin:24px 0 8px">Еконт — за изпращане (${econtOrders.length})</h2>` +
        econtOrders.map((o) => orderBlock(o, econtDestination(o))).join('')
      : '';

  return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Твоите доставки за ${date}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">
    ${escapeHtml(farmerName)} — доставки за ${date}
  </h1>
  <h2 style="font-size:16px;color:#333;margin:20px 0 8px">За приготвяне</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${prepRows}</tbody></table>
  ${pickupSection}
  ${addressSection}
  ${econtSection}
  <p style="font-size:12px;color:#999;margin-top:32px">FarmFlow — автоматичен дайджест за фермер</p>
</body>
</html>`;
}

function renderFarmerText(
  date: string,
  farmerName: string,
  prep: FarmerItem[],
  addressOrders: FarmerOrder[],
  econtOrders: FarmerOrder[],
  pickupOrders: FarmerOrder[],
): string {
  const lines: string[] = [`${farmerName} — доставки за ${date}`, '', 'За приготвяне:'];
  for (const p of prep) lines.push(`  • ${p.productName} — ${p.quantity} бр`);
  lines.push('');

  if (pickupOrders.length > 0) {
    lines.push(`За вземане (${pickupOrders.length}):`);
    for (const o of pickupOrders) {
      lines.push(`  • ${o.customerName ?? '—'} — За вземане на място`);
      for (const it of o.items) lines.push(`      - ${it.productName} × ${it.quantity}`);
    }
    lines.push('');
  }

  if (addressOrders.length > 0) {
    lines.push(`Доставка до адрес (${addressOrders.length}):`);
    for (const o of addressOrders) {
      const slot = o.slotFrom && o.slotTo ? ` [${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}]` : '';
      lines.push(`  • ${o.customerName ?? '—'} — ${o.deliveryAddress ?? '—'}${slot}`);
      for (const it of o.items) lines.push(`      - ${it.productName} × ${it.quantity}`);
    }
    lines.push('');
  }

  if (econtOrders.length > 0) {
    lines.push(`Еконт — за изпращане (${econtOrders.length}):`);
    for (const o of econtOrders) {
      lines.push(`  • ${o.customerName ?? '—'} — ${econtDestination(o)}`);
      for (const it of o.items) lines.push(`      - ${it.productName} × ${it.quantity}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly email: EmailService,
  ) {}

  /**
   * Query confirmed orders for a tenant on a given date and build email content.
   * Returns null when there are zero confirmed orders.
   */
  async buildDigest(tenantId: string, date: string): Promise<DigestResult | null> {
    const rows = await this.db
      .select({
        id: orders.id,
        deliveryType: orders.deliveryType,
        customerName: orders.customerName,
        deliveryAddress: orders.deliveryAddress,
        deliveryCity: orders.deliveryCity,
        econtOffice: orders.econtOffice,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          sql`${bgDate(orders.createdAt)} = ${date}`,
        )!,
      )
      .orderBy(orders.createdAt);

    if (rows.length === 0) return null;

    const addressOrders = rows.filter((r) => r.deliveryType === 'address');
    const econtOrders = rows.filter(
      (r) => r.deliveryType === 'econt' || r.deliveryType === 'econt_address',
    );
    const distinctCustomers = new Set(
      rows.map((o) => o.customerName?.trim().toLowerCase()),
    ).size;

    const html = renderHtml(date, addressOrders, econtOrders);
    const text = renderText(date, addressOrders, econtOrders);

    return {
      html,
      text,
      summary: {
        selfDeliveryCount: addressOrders.length,
        econtCount: econtOrders.length,
        totalOrders: rows.length,
        distinctCustomers,
      },
    };
  }

  /**
   * Build a per-farmer digest: only orders containing this farmer's products,
   * showing a prep summary + per-order breakdown of the farmer's own line items.
   * Returns null when the farmer has no items on the date.
   */
  async buildFarmerDigest(
    tenantId: string,
    farmerId: string,
    date: string,
    farmerName = '',
  ): Promise<DigestResult | null> {
    const rows = await this.db
      .select({
        orderId: orders.id,
        deliveryType: orders.deliveryType,
        customerName: orders.customerName,
        deliveryAddress: orders.deliveryAddress,
        deliveryCity: orders.deliveryCity,
        econtOffice: orders.econtOffice,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        productName: orderItems.productName,
        quantity: orderItems.quantity,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .innerJoin(products, eq(orderItems.productId, products.id))
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          sql`${bgDate(orders.createdAt)} = ${date}`,
          eq(products.farmerId, farmerId),
        )!,
      )
      .orderBy(orders.createdAt);

    if (rows.length === 0) return null;

    // Group line items by order.
    const byOrder = new Map<string, FarmerOrder>();
    for (const r of rows) {
      let o = byOrder.get(r.orderId);
      if (!o) {
        o = {
          id: r.orderId,
          deliveryType: r.deliveryType,
          customerName: r.customerName,
          deliveryAddress: r.deliveryAddress,
          deliveryCity: r.deliveryCity,
          econtOffice: r.econtOffice,
          slotFrom: r.slotFrom,
          slotTo: r.slotTo,
          items: [],
        };
        byOrder.set(r.orderId, o);
      }
      o.items.push({ productName: r.productName ?? '—', quantity: r.quantity });
    }
    const orderList = [...byOrder.values()];
    const addressOrders = orderList.filter((o) => o.deliveryType === 'address');
    const econtOrders = orderList.filter(
      (o) => o.deliveryType === 'econt' || o.deliveryType === 'econt_address',
    );
    const pickupOrders = orderList.filter((o) => o.deliveryType === 'pickup');

    // Prep summary: total qty per product across the day.
    const prepMap = new Map<string, number>();
    for (const r of rows) {
      const name = r.productName ?? '—';
      prepMap.set(name, (prepMap.get(name) ?? 0) + r.quantity);
    }
    const prep: FarmerItem[] = [...prepMap.entries()]
      .map(([productName, quantity]) => ({ productName, quantity }))
      .sort((a, b) => b.quantity - a.quantity);

    const distinctCustomers = new Set(
      orderList.map((o) => o.customerName?.trim().toLowerCase()),
    ).size;

    return {
      html: renderFarmerHtml(date, farmerName, prep, addressOrders, econtOrders, pickupOrders),
      text: renderFarmerText(date, farmerName, prep, addressOrders, econtOrders, pickupOrders),
      summary: {
        selfDeliveryCount: addressOrders.length,
        econtCount: econtOrders.length,
        totalOrders: orderList.length,
        distinctCustomers,
      },
    };
  }

  /**
   * Daily cron at 07:00 Europe/Sofia: send digests to all tenants that have
   * an email configured and confirmed orders for today.
   */
  @Cron('0 7 * * *', { timeZone: 'Europe/Sofia' })
  async runDailyDigests(): Promise<void> {
    const today = bgToday();

    const tenantRows = await this.db
      .select({ id: tenants.id, email: tenants.email })
      .from(tenants)
      .where(isNotNull(tenants.email))
      .orderBy(tenants.id);

    for (const tenant of tenantRows) {
      if (!tenant.email) continue;
      try {
        const digest = await this.buildDigest(tenant.id, today);
        if (!digest) {
          this.logger.log(`[digest] No orders for tenant=${tenant.id} on ${today} — skipping`);
          continue;
        }
        await this.email.sendMail({
          to: tenant.email,
          subject: 'Доставки за днес — FarmFlow',
          html: digest.html,
          text: digest.text,
        });
        this.logger.log(
          `[digest] Sent to tenant=${tenant.id} orders=${digest.summary.totalOrders}`,
        );
      } catch (err) {
        this.logger.error(
          `[digest] Failed for tenant=${tenant.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  /**
   * Used by POST /digest/test: build today's digest for the given tenant and
   * send it to that tenant's email immediately. Returns { sent, reason? }.
   */
  async sendTestDigest(tenantId: string): Promise<{ sent: boolean; reason?: string }> {
    const today = bgToday();

    const [tenant] = await this.db
      .select({ email: tenants.email })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    if (!tenant?.email) {
      return { sent: false, reason: 'no-email' };
    }

    const digest = await this.buildDigest(tenantId, today);
    if (!digest) {
      return { sent: false, reason: 'no-orders' };
    }

    await this.email.sendMail({
      to: tenant.email,
      subject: 'Доставки за днес — FarmFlow (тест)',
      html: digest.html,
      text: digest.text,
    });

    return { sent: true };
  }
}
