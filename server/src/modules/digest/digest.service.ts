import { Injectable, Inject, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import { type Database, orders, deliverySlots, tenants } from '@farmflow/db';
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
