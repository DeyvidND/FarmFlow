import { Inject, Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { type Database, orders, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Econt's public tracking page for a waybill number. */
export function trackingUrl(number: string): string {
  return `https://www.econt.com/services/track-shipment/${number.replace(/\s/g, '')}/`;
}

/** Public tracking page for a waybill, by carrier — the link the buyer follows. */
export function carrierTrackingUrl(carrier: 'econt' | 'speedy', number: string): string {
  const n = number.replace(/\s/g, '');
  return carrier === 'speedy'
    ? `https://www.speedy.bg/bg/track-shipment?shipmentNumber=${n}`
    : `https://www.econt.com/services/track-shipment/${n}/`;
}

const CARRIER_LABEL: Record<'econt' | 'speedy', string> = { econt: 'Еконт', speedy: 'Speedy' };

/**
 * Emails the buyer that their parcel has shipped, with the Econt tracking link.
 * Self-contained (DB + EmailService only) and error-swallowing — a refresh cycle
 * must never fail because mail failed.
 */
@Injectable()
export class ShipmentEmailService {
  private readonly logger = new Logger(ShipmentEmailService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly email: EmailService,
  ) {}

  async sendShipped(orderId: string, shipmentNumber: string, carrier: 'econt' | 'speedy' = 'econt'): Promise<void> {
    try {
      const [order] = await this.db
        .select({
          customerName: orders.customerName,
          customerEmail: orders.customerEmail,
          tenantId: orders.tenantId,
        })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      const to = order?.customerEmail?.trim();
      if (!to) return;

      const [tenant] = order.tenantId
        ? await this.db.select({ name: tenants.name }).from(tenants).where(eq(tenants.id, order.tenantId)).limit(1)
        : [undefined];
      const farmName = tenant?.name ?? 'ФермериБГ';
      const safeFarmName = farmName.replace(/[\r\n]+/g, ' ').trim();
      const link = carrierTrackingUrl(carrier, shipmentNumber);
      const carrierLabel = CARRIER_LABEL[carrier];

      await this.email.sendMail({
        to,
        subject: `Пратката ти е изпратена — ${safeFarmName}`.trim(),
        html: this.renderHtml(order.customerName, farmName, shipmentNumber, link, carrierLabel),
        text: [
          `${farmName} — пратката ти е изпратена с ${carrierLabel}.`,
          order.customerName ? `Здравей, ${order.customerName}!` : '',
          `Товарителница: ${shipmentNumber}`,
          `Проследи: ${link}`,
        ].filter(Boolean).join('\n'),
        stream: 'transactional',
      });
    } catch (err) {
      this.logger.error(`shipped email failed for ${orderId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private renderHtml(customerName: string | null, farmName: string, number: string, link: string, carrierLabel: string): string {
    const hi = customerName ? `Здравей, ${esc(customerName)}! ` : '';
    return `<!doctype html><html lang="bg"><body style="margin:0;background:#f6f4ec;font-family:Arial,Helvetica,sans-serif;color:#23210f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ec;padding:28px 0"><tr><td align="center">
    <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf7;border:1px solid #e7e3d6;border-radius:16px;overflow:hidden">
      <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🚚 ${esc(farmName)}</td></tr>
      <tr><td style="padding:28px">
        <h1 style="margin:0 0 6px;font-size:22px;color:#23210f">Пратката ти пътува!</h1>
        <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">${hi}Поръчката ти беше предадена на ${esc(carrierLabel)} и вече пътува към теб.</p>
        <div style="margin:18px 0;padding:14px 16px;background:#f3f6f0;border:1px solid #e1e9dd;border-radius:12px">
          <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#8a8770;margin-bottom:4px">Товарителница</div>
          <div style="font-size:16px;font-weight:bold;color:#23210f">${esc(number)}</div>
        </div>
        <p style="margin:22px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#2d6a4f;color:#fff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 20px;border-radius:10px">Проследи пратката</a></p>
      </td></tr>
      <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">${esc(farmName)} · Благодарим, че пазаруваш от местни производители 🌱</td></tr>
    </table>
  </td></tr></table>
</body></html>`;
  }
}
