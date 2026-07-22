import { Injectable, Inject, Logger, BadRequestException } from '@nestjs/common';
import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { type Database, orders, orderItems, products, deliverySlots, tenants, farmers } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { bgToday, bgAddDays } from '../../common/time/bg-time';
import { scheduledForDay, scheduledForRange } from '../orders/order-scheduling';
import { harvestSummary } from '../orders/harvest-summary';

/** Statuses an organizer may pick for a manual farmer-orders send. */
const ALLOWED_STATUSES = ['pending', 'confirmed', 'delivered'] as const;
/** Widest [from,to] span accepted by {@link DigestService.sendFarmerOrderEmails}. */
const MAX_RANGE_DAYS = 31;

interface DigestOrder {
  id: string;
  deliveryType: string;
  customerName: string | null;
  deliveryAddress: string | null;
  deliveryCity: string | null;
  econtOffice: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  paymentMethod: string;
  totalStotinki: number;
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

/** stotinki → "25,99 €" for digest amounts. */
function eur(stotinki: number): string {
  return (stotinki / 100).toFixed(2).replace('.', ',') + ' €';
}

/** Suffix shown on a customer line when they pay наложен платеж. */
function codTag(o: DigestOrder): string {
  return o.paymentMethod === 'cod' ? ` · наложен платеж — ${eur(o.totalStotinki)}` : '';
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

/** One line-item row feeding a per-farmer digest. Shared by the single-farmer
 *  build and the batched daily send (the batch adds farmerId for grouping). */
interface FarmerDigestRow {
  orderId: string;
  deliveryType: string;
  customerName: string | null;
  deliveryAddress: string | null;
  deliveryCity: string | null;
  econtOffice: string | null;
  slotFrom: string | null;
  slotTo: string | null;
  productName: string | null;
  quantity: number;
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

function renderHtml(
  date: string,
  pickupOrders: DigestOrder[],
  addressOrders: DigestOrder[],
  econtOrders: DigestOrder[],
): string {
  const totalOrders = pickupOrders.length + addressOrders.length + econtOrders.length;
  const distinctCustomers = new Set(
    [...pickupOrders, ...addressOrders, ...econtOrders].map((o) =>
      o.customerName?.trim().toLowerCase(),
    ),
  ).size;

  const pickupRows = pickupOrders
    .map((o) => {
      const slot =
        o.slotFrom && o.slotTo ? `${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}` : '—';
      return `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.customerName ?? '—')}${escapeHtml(codTag(o))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${slot}</td>
        </tr>`;
    })
    .join('');

  const addressRows = addressOrders
    .map((o) => {
      const slot =
        o.slotFrom && o.slotTo
          ? `${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}`
          : '—';
      return `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.customerName ?? '—')}${escapeHtml(codTag(o))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.deliveryAddress ?? '—')}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${slot}</td>
        </tr>`;
    })
    .join('');

  const econtRows = econtOrders
    .map(
      (o) => `
        <tr>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(o.customerName ?? '—')}${escapeHtml(codTag(o))}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #eee">${escapeHtml(econtDestination(o))}</td>
        </tr>`,
    )
    .join('');

  const pickupSection =
    pickupOrders.length > 0
      ? `
      <h2 style="font-size:16px;color:#333;margin:24px 0 8px">За вземане (${pickupOrders.length})</h2>
      <table style="width:100%;border-collapse:collapse;font-size:14px">
        <thead>
          <tr style="background:#f5f5f5">
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Клиент</th>
            <th style="padding:6px 8px;text-align:left;border-bottom:2px solid #ddd">Час</th>
          </tr>
        </thead>
        <tbody>${pickupRows}</tbody>
      </table>`
      : '';

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
    За вземане: <strong>${pickupOrders.length}</strong> &nbsp;|&nbsp;
    До адрес: <strong>${addressOrders.length}</strong> &nbsp;|&nbsp;
    Еконт: <strong>${econtOrders.length}</strong> &nbsp;|&nbsp;
    Уникални клиенти: <strong>${distinctCustomers}</strong>
  </p>
  ${pickupSection}
  ${addressSection}
  ${econtSection}
  <p style="font-size:12px;color:#999;margin-top:32px">ФермериБГ — автоматичен дайджест</p>
</body>
</html>`;
}

function renderText(
  date: string,
  pickupOrders: DigestOrder[],
  addressOrders: DigestOrder[],
  econtOrders: DigestOrder[],
): string {
  const lines: string[] = [`Доставки за ${date}`, ''];
  lines.push(`Общо: ${pickupOrders.length + addressOrders.length + econtOrders.length} поръчки`);
  lines.push('');

  if (pickupOrders.length > 0) {
    lines.push(`За вземане (${pickupOrders.length}):`);
    for (const o of pickupOrders) {
      const slot = o.slotFrom && o.slotTo ? ` [${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}]` : '';
      lines.push(`  • ${o.customerName ?? '—'} — За вземане на място${slot}${codTag(o)}`);
    }
    lines.push('');
  }

  if (addressOrders.length > 0) {
    lines.push(`Доставка до адрес (${addressOrders.length}):`);
    for (const o of addressOrders) {
      const slot = o.slotFrom && o.slotTo ? ` [${hhmm(o.slotFrom)}–${hhmm(o.slotTo)}]` : '';
      lines.push(`  • ${o.customerName ?? '—'} — ${o.deliveryAddress ?? '—'}${slot}${codTag(o)}`);
    }
    lines.push('');
  }

  if (econtOrders.length > 0) {
    lines.push(`Еконт — за изпращане (${econtOrders.length}):`);
    for (const o of econtOrders) {
      lines.push(`  • ${o.customerName ?? '—'} — ${econtDestination(o)}${codTag(o)}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

/** Pure grouping of a farmer's day rows into delivery-type buckets + prep list.
 *  Shared by the single-day digest and the range email. */
function groupFarmerRows(rows: FarmerDigestRow[]): {
  orderList: FarmerOrder[];
  addressOrders: FarmerOrder[];
  econtOrders: FarmerOrder[];
  pickupOrders: FarmerOrder[];
  prep: FarmerItem[];
} {
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
        paymentMethod: 'online',
        totalStotinki: 0,
        items: [],
      };
      byOrder.set(r.orderId, o);
    }
    o.items.push({ productName: r.productName ?? '—', quantity: r.quantity });
  }
  // orderList = every distinct order from the input rows, regardless of
  // deliveryType (includes e.g. 'courier' split-leg orders, which have no
  // section of their own in the rendered email — see the three buckets below).
  const orderList = [...byOrder.values()];
  return {
    orderList,
    addressOrders: orderList.filter((o) => o.deliveryType === 'address'),
    econtOrders: orderList.filter(
      (o) => o.deliveryType === 'econt' || o.deliveryType === 'econt_address',
    ),
    pickupOrders: orderList.filter((o) => o.deliveryType === 'pickup'),
    prep: harvestSummary(rows),
  };
}

/** Inner HTML fragment for one day: prep table + pickup/address/econt sections.
 *  No <html>/<body> wrapper — shared by the single-day email and range email. */
function renderFarmerSectionsHtml(
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

  return `<h2 style="font-size:16px;color:#333;margin:20px 0 8px">За приготвяне</h2>
  <table style="width:100%;border-collapse:collapse;font-size:14px"><tbody>${prepRows}</tbody></table>
  ${pickupSection}
  ${addressSection}
  ${econtSection}`;
}

/** stotinki-free header period label, e.g. "10.07.2026 – 12.07.2026" or a single day. */
function periodLabel(from: string, to: string): string {
  return from === to ? from : `${from} – ${to}`;
}

/** One farmer's multi-day order email. `byDay` keyed by YYYY-MM-DD. */
function assembleFarmerRangeEmail(
  from: string,
  to: string,
  farmerName: string,
  byDay: Map<string, FarmerDigestRow[]>,
): DigestResult | null {
  const days = [...byDay.entries()]
    .filter(([, rows]) => rows.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  if (days.length === 0) return null;

  let totalOrders = 0;
  const htmlSections: string[] = [];
  const textSections: string[] = [];
  for (const [date, rows] of days) {
    const { orderList, addressOrders, econtOrders, pickupOrders, prep } = groupFarmerRows(rows);
    // Full order count for the day (includes deliveryType values like 'courier'
    // that don't get their own rendered section — see groupFarmerRows).
    totalOrders += orderList.length;
    htmlSections.push(
      `<h2 style="font-size:18px;color:#2d6a4f;margin:28px 0 4px;border-bottom:1px solid #cde">${date}</h2>` +
        renderFarmerSectionsHtml(prep, addressOrders, econtOrders, pickupOrders),
    );
    textSections.push(
      `=== ${date} ===\n` + renderFarmerText(date, farmerName, prep, addressOrders, econtOrders, pickupOrders),
    );
  }

  const label = periodLabel(from, to);
  const html = `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Твоите поръчки за ${label}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">
    ${escapeHtml(farmerName)} — поръчки за ${label}
  </h1>
  ${htmlSections.join('\n')}
  <p style="font-size:12px;color:#999;margin-top:32px">ФермериБГ</p>
</body>
</html>`;
  const text = `${farmerName} — поръчки за ${label}\n\n${textSections.join('\n\n')}`;

  return {
    html,
    text,
    summary: { selfDeliveryCount: 0, econtCount: 0, totalOrders, distinctCustomers: 0 },
  };
}

function renderFarmerHtml(
  date: string,
  farmerName: string,
  prep: FarmerItem[],
  addressOrders: FarmerOrder[],
  econtOrders: FarmerOrder[],
  pickupOrders: FarmerOrder[],
): string {
  return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Твоите доставки за ${date}</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">
    ${escapeHtml(farmerName)} — доставки за ${date}
  </h1>
  ${renderFarmerSectionsHtml(prep, addressOrders, econtOrders, pickupOrders)}
  <p style="font-size:12px;color:#999;margin-top:32px">ФермериБГ — автоматичен дайджест за фермер</p>
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
   * Query confirmed orders for a tenant on a given delivery day and build email
   * content. Returns null when there are zero confirmed orders.
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
        paymentMethod: orders.paymentMethod,
        totalStotinki: orders.totalStotinki,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
      })
      .from(orders)
      .leftJoin(deliverySlots, eq(orders.slotId, deliverySlots.id))
      .where(
        and(
          eq(orders.tenantId, tenantId),
          eq(orders.status, 'confirmed'),
          scheduledForDay(date),
        )!,
      )
      .orderBy(orders.createdAt);

    if (rows.length === 0) return null;

    const pickupOrders = rows.filter((r) => r.deliveryType === 'pickup');
    const addressOrders = rows.filter((r) => r.deliveryType === 'address');
    const econtOrders = rows.filter(
      (r) => r.deliveryType === 'econt' || r.deliveryType === 'econt_address',
    );
    const distinctCustomers = new Set(
      rows.map((o) => o.customerName?.trim().toLowerCase()),
    ).size;

    const html = renderHtml(date, pickupOrders, addressOrders, econtOrders);
    const text = renderText(date, pickupOrders, addressOrders, econtOrders);

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
          scheduledForDay(date),
          eq(products.farmerId, farmerId),
        )!,
      )
      .orderBy(orders.createdAt);

    return this.assembleFarmerDigest(date, farmerName, rows);
  }

  /**
   * Assemble a farmer digest from its already-fetched line-item rows. Pure (no
   * DB) — shared by {@link buildFarmerDigest} (single farmer) and the batched
   * {@link sendFarmerDigests} path. Returns null when the farmer has no rows.
   */
  private assembleFarmerDigest(
    date: string,
    farmerName: string,
    rows: FarmerDigestRow[],
  ): DigestResult | null {
    if (rows.length === 0) return null;
    const { orderList, addressOrders, econtOrders, pickupOrders, prep } = groupFarmerRows(rows);
    // Full order list (not just the three rendered buckets) — deliveryType
    // values like 'courier' are real confirmed orders with no section of their
    // own, but must still count toward the summary totals.
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
   * Send a per-farmer digest to every farmer of the tenant that has an email
   * and items for the date. Returns how many emails were sent. Per-farmer
   * try/catch so one failure does not abort the rest. `subjectOverride` lets
   * {@link sendTomorrowFarmerEmails} (Task #14) reuse this exact batch query
   * + per-farmer send loop for a "tomorrow" email instead of "today" (only the
   * `date` passed in and the subject line differ).
   */
  private async sendFarmerDigests(
    tenantId: string,
    date: string,
    testMode = false,
    subjectOverride?: string,
  ): Promise<number> {
    const farmerRows = await this.db
      .select({ id: farmers.id, name: farmers.name, email: farmers.email })
      .from(farmers)
      .where(and(eq(farmers.tenantId, tenantId), isNotNull(farmers.email))!)
      .orderBy(farmers.id);
    if (farmerRows.length === 0) return 0;

    // Batch: one query for every farmer's line items for the day, grouped by
    // farmerId in JS — instead of a per-farmer query inside the loop (N+1 across
    // the tenant's farmers).
    const rows = await this.db
      .select({
        farmerId: products.farmerId,
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
          scheduledForDay(date),
        )!,
      )
      .orderBy(orders.createdAt);

    const byFarmer = new Map<string, FarmerDigestRow[]>();
    for (const r of rows) {
      if (!r.farmerId) continue;
      const list = byFarmer.get(r.farmerId) ?? [];
      list.push(r);
      byFarmer.set(r.farmerId, list);
    }

    let sent = 0;
    for (const f of farmerRows) {
      if (!f.email) continue;
      try {
        const digest = this.assembleFarmerDigest(date, f.name, byFarmer.get(f.id) ?? []);
        if (!digest) continue;
        await this.email.sendMail({
          to: f.email,
          subject: subjectOverride ?? `Твоите доставки за днес — ФермериБГ${testMode ? ' (тест)' : ''}`,
          html: digest.html,
          text: digest.text,
        });
        sent++;
        this.logger.log(`[digest] Farmer sent tenant=${tenantId} farmer=${f.id}`);
      } catch (err) {
        this.logger.error(
          `[digest] Farmer failed tenant=${tenantId} farmer=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return sent;
  }

  /** Tenant ids eligible for a daily digest (have an email OR are multi-farmer). */
  async eligibleTenantIds(): Promise<string[]> {
    const rows = await this.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(or(isNotNull(tenants.email), eq(tenants.multiFarmer, true))!)
      .orderBy(tenants.id);
    return rows.map((r) => r.id);
  }

  /** Every tenant id — used by the Task #14 tomorrow-email fan-out. UNLIKE
   *  {@link eligibleTenantIds} this is NOT gated on tenant.email/multiFarmer:
   *  the per-farmer tomorrow email must reach single-farmer shops too, not
   *  just multi-farmer ones. Fanning a job out to every tenant is cheap; each
   *  job internally no-ops (0 sent) when the tenant has no farmers-with-email
   *  or no orders tomorrow. */
  async allTenantIds(): Promise<string[]> {
    const rows = await this.db.select({ id: tenants.id }).from(tenants).orderBy(tenants.id);
    return rows.map((r) => r.id);
  }

  /**
   * Task #14: email every farmer of the tenant (that has an email and items)
   * TOMORROW's confirmed orders — reuses {@link sendFarmerDigests}'s exact
   * batch query + per-farmer send loop, just against tomorrow's date and a
   * distinct subject. Runs regardless of tenants.multiFarmer (single-farmer
   * shops get this too — unlike the existing today-digest, which only sends
   * per-farmer mail in multi-farmer mode).
   */
  async sendTomorrowFarmerEmails(tenantId: string, testMode = false): Promise<number> {
    const tomorrow = bgAddDays(bgToday(), 1);
    return this.sendFarmerDigests(
      tenantId,
      tomorrow,
      testMode,
      `Утре: твоите поръчки за приготвяне — ФермериБГ${testMode ? ' (тест)' : ''}`,
    );
  }

  /** Per-tenant job body for the Task #14 tomorrow-email fan-out (mirrors
   *  {@link runForTenant}'s per-tenant job body for the today-digest fan-out). */
  async runTomorrowForTenant(tenantId: string): Promise<void> {
    const sent = await this.sendTomorrowFarmerEmails(tenantId);
    if (sent > 0) this.logger.log(`[digest] tomorrow-email sent tenant=${tenantId} farmers=${sent}`);
  }

  /** Build + enqueue (via EmailService) the digests for ONE tenant. Mirrors the
   *  per-tenant body of the former runDailyDigests so each tenant retries
   *  independently as its own BullMQ job.
   *  NOT idempotent: if this throws after the owner email was enqueued, the whole
   *  tenant job retries and the owner can receive a duplicate digest. Accepted
   *  at-least-once trade-off (a duplicate daily digest is low-harm). */
  async runForTenant(tenantId: string): Promise<void> {
    const today = bgToday();
    const [tenant] = await this.db
      .select({ id: tenants.id, email: tenants.email, multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant) return;

    if (tenant.email) {
      const digest = await this.buildDigest(tenant.id, today);
      if (digest) {
        await this.email.sendMail({
          to: tenant.email,
          subject: 'Доставки за днес — ФермериБГ',
          html: digest.html,
          text: digest.text,
        });
        this.logger.log(`[digest] owner queued tenant=${tenant.id} orders=${digest.summary.totalOrders}`);
      }
    }
    if (tenant.multiFarmer) {
      await this.sendFarmerDigests(tenant.id, today);
    }
  }

  /**
   * Used by POST /digest/test: build today's owner digest for the tenant and
   * (in multi-farmer mode) the per-farmer digests, sending immediately.
   */
  async sendTestDigest(
    tenantId: string,
  ): Promise<{ sent: boolean; reason?: string; farmersSent: number }> {
    const today = bgToday();

    const [tenant] = await this.db
      .select({ email: tenants.email, multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);

    const farmersSent = tenant?.multiFarmer
      ? await this.sendFarmerDigests(tenantId, today, true)
      : 0;

    if (!tenant?.email) {
      return { sent: false, reason: 'no-email', farmersSent };
    }

    const digest = await this.buildDigest(tenantId, today);
    if (!digest) {
      return { sent: false, reason: 'no-orders', farmersSent };
    }

    await this.email.sendMail({
      to: tenant.email,
      subject: 'Доставки за днес — ФермериБГ (тест)',
      html: digest.html,
      text: digest.text,
    });

    return { sent: true, farmersSent };
  }

  /**
   * Shared validation + batch query for the organizer-triggered farmer-orders
   * send/preview: resolves the selected farmers (tenant-scoped, email-having)
   * and their line items across the [from,to] range, grouped by farmerId →
   * day. Used by both {@link sendFarmerOrderEmails} and
   * {@link previewFarmerOrderEmails} so the two stay in lockstep — a farmer
   * the preview shows as "will receive" is exactly one the send will email.
   */
  private async resolveFarmerOrderBatch(
    tenantId: string,
    opts: { from: string; to: string; farmerIds: string[]; statuses: string[] },
  ): Promise<{
    farmerRows: { id: string; name: string; email: string | null }[];
    byFarmer: Map<string, Map<string, FarmerDigestRow[]>>;
  }> {
    const { from, to } = opts;

    const [tenant] = await this.db
      .select({ multiFarmer: tenants.multiFarmer })
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    if (!tenant?.multiFarmer) {
      throw new BadRequestException('Тази функция е само за магазини с няколко фермери.');
    }
    if (from > to) {
      throw new BadRequestException('Началната дата е след крайната.');
    }
    // Inclusive day span. (Both are YYYY-MM-DD; parse as UTC midnight.)
    const spanDays =
      Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
    if (spanDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(`Периодът е твърде голям (макс. ${MAX_RANGE_DAYS} дни).`);
    }

    const statuses = opts.statuses.filter((s): s is (typeof ALLOWED_STATUSES)[number] =>
      (ALLOWED_STATUSES as readonly string[]).includes(s),
    );
    if (statuses.length === 0) {
      throw new BadRequestException('Изберете поне един валиден статус.');
    }
    if (opts.farmerIds.length === 0) {
      throw new BadRequestException('Изберете поне един фермер.');
    }

    // Selected farmers that actually belong to this tenant AND have an email.
    const farmerRows = await this.db
      .select({ id: farmers.id, name: farmers.name, email: farmers.email })
      .from(farmers)
      .where(
        and(
          eq(farmers.tenantId, tenantId),
          inArray(farmers.id, opts.farmerIds),
          isNotNull(farmers.email),
        )!,
      );
    if (farmerRows.length === 0) {
      throw new BadRequestException('Няма избран фермер с имейл адрес.');
    }

    // One batch query for every selected farmer's line items across the range.
    const rows = await this.db
      .select({
        farmerId: products.farmerId,
        orderId: orders.id,
        deliveryType: orders.deliveryType,
        customerName: orders.customerName,
        deliveryAddress: orders.deliveryAddress,
        deliveryCity: orders.deliveryCity,
        econtOffice: orders.econtOffice,
        slotFrom: deliverySlots.timeFrom,
        slotTo: deliverySlots.timeTo,
        slotDate: deliverySlots.date,
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
          inArray(orders.status, statuses),
          scheduledForRange(from, to),
          inArray(products.farmerId, farmerRows.map((f) => f.id)),
        )!,
      )
      .orderBy(orders.createdAt);

    // Group rows: farmerId → (slotDate-or-null bucketed to a day) → rows.
    // Slotless orders count on their scheduled day; for range display we bucket
    // them under `from` day when slotDate is null (they were selected by the
    // createdAt fallback in scheduledForRange, so their exact day isn't in the
    // slot column — group them under the range start so they still appear).
    const byFarmer = new Map<string, Map<string, FarmerDigestRow[]>>();
    for (const r of rows) {
      const fid = r.farmerId;
      if (!fid) continue;
      const day = (r.slotDate as string | null) ?? from;
      const farmerMap = byFarmer.get(fid) ?? new Map();
      const dayRows = farmerMap.get(day) ?? [];
      dayRows.push(r);
      farmerMap.set(day, dayRows);
      byFarmer.set(fid, farmerMap);
    }

    return { farmerRows, byFarmer };
  }

  /**
   * Organizer-triggered: email each SELECTED farmer their own orders for the
   * [from,to] BG-day range, limited to the chosen statuses. Reuses the range
   * assembler. One batch line-item query (no N+1). Per-farmer try/catch so a
   * single failed send doesn't abort the rest. Returns how many farmers were
   * emailed vs skipped (selected, has email, but no orders / send failed).
   */
  async sendFarmerOrderEmails(
    tenantId: string,
    opts: { from: string; to: string; farmerIds: string[]; statuses: string[] },
  ): Promise<{ sent: number; skipped: number }> {
    const { from, to } = opts;
    const { farmerRows, byFarmer } = await this.resolveFarmerOrderBatch(tenantId, opts);

    let sent = 0;
    let skipped = 0;
    for (const f of farmerRows) {
      const byDay = byFarmer.get(f.id);
      const email = assembleFarmerRangeEmail(from, to, f.name, byDay ?? new Map());
      if (!email) {
        skipped++;
        continue;
      }
      try {
        await this.email.sendMail({
          to: f.email!,
          subject: `Твоите поръчки за ${periodLabel(from, to)} — ФермериБГ`,
          html: email.html,
          text: email.text,
        });
        sent++;
        this.logger.log(`[digest] farmer-orders sent tenant=${tenantId} farmer=${f.id}`);
      } catch (err) {
        skipped++;
        this.logger.error(
          `[digest] farmer-orders failed tenant=${tenantId} farmer=${f.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return { sent, skipped };
  }

  /**
   * Preview-only counterpart to {@link sendFarmerOrderEmails}: same selection
   * and validation, but never calls the mailer. Returns exactly the farmers
   * that would receive an email (name + email + how many of their orders are
   * in the range) so the organizer can check the recipient list before
   * committing to a send.
   */
  async previewFarmerOrderEmails(
    tenantId: string,
    opts: { from: string; to: string; farmerIds: string[]; statuses: string[] },
  ): Promise<{ recipients: { id: string; name: string; email: string; orderCount: number }[]; skipped: number }> {
    const { from, to } = opts;
    const { farmerRows, byFarmer } = await this.resolveFarmerOrderBatch(tenantId, opts);

    const recipients: { id: string; name: string; email: string; orderCount: number }[] = [];
    let skipped = 0;
    for (const f of farmerRows) {
      const byDay = byFarmer.get(f.id);
      const email = assembleFarmerRangeEmail(from, to, f.name, byDay ?? new Map());
      if (!email) {
        skipped++;
        continue;
      }
      recipients.push({ id: f.id, name: f.name, email: f.email!, orderCount: email.summary.totalOrders });
    }
    return { recipients, skipped };
  }
}

/** Test-only surface for the pure range assembler. */
export const __rangeInternals = { assembleFarmerRangeEmail };
