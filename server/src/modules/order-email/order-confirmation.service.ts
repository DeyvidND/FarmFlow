import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { asc, eq, inArray } from 'drizzle-orm';
import {
  type Database,
  orders,
  orderItems,
  products,
  productMedia,
  tenants,
} from '@farmflow/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';

type OrderRow = typeof orders.$inferSelect;

interface EmailItem {
  name: string;
  quantity: number;
  priceStotinki: number;
  imageUrl: string | null;
  tint: string | null;
}

/** Bulgarian labels for the order's delivery method. */
const DELIVERY_LABELS: Record<string, string> = {
  pickup: 'Вземане от място',
  address: 'Доставка до адрес',
  econt: 'Еконт — до офис',
  econt_address: 'Еконт — до адрес',
};

/** Format integer stotinki (EUR cents) as "4,99 €" — matches the storefront. */
function money(stotinki: number): string {
  return (stotinki / 100).toFixed(2).replace('.', ',') + ' €';
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
/** Escape user-supplied content before interpolating into the email HTML. */
function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/**
 * Sends the buyer their order-confirmation email when an order becomes
 * `confirmed`. Self-contained (depends only on the global DB + EmailService),
 * so both OrdersService (cash / admin confirm) and StripeService (online
 * payment) can fire it without a circular module dependency.
 */
@Injectable()
export class OrderConfirmationService {
  private readonly logger = new Logger(OrderConfirmationService.name);
  private readonly storefrontUrl: string;

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly email: EmailService,
    config: ConfigService,
  ) {
    this.storefrontUrl = (config.get<string>('STOREFRONT_URL') ?? 'http://localhost:3003')
      .trim()
      .replace(/\/+$/, '');
  }

  /** Email the buyer that we RECEIVED their order — fired on placement (cash path). */
  async sendReceived(orderId: string): Promise<void> {
    return this.send(orderId, 'received');
  }

  /**
   * Email the buyer their confirmation when the order becomes `confirmed`.
   * Fire-and-forget from callers (the confirm transition must never block on
   * mail) — so this swallows its own errors and no-ops when there's no email.
   */
  async sendForOrder(orderId: string): Promise<void> {
    return this.send(orderId, 'confirmed');
  }

  private async send(orderId: string, phase: 'received' | 'confirmed'): Promise<void> {
    try {
      const [order] = await this.db
        .select()
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1);
      if (!order) return;
      const to = order.customerEmail?.trim();
      if (!to) return; // guest checkout without an email — nothing to send

      const [tenant] = order.tenantId
        ? await this.db
            .select({ name: tenants.name })
            .from(tenants)
            .where(eq(tenants.id, order.tenantId))
            .limit(1)
        : [undefined];
      const farmName = tenant?.name ?? 'FarmFlow';

      const rawItems = await this.db
        .select({
          productId: orderItems.productId,
          name: orderItems.productName,
          quantity: orderItems.quantity,
          priceStotinki: orderItems.priceStotinki,
        })
        .from(orderItems)
        .where(eq(orderItems.orderId, orderId));
      const items = await this.withImages(rawItems);

      // Strip CR/LF from the tenant-controlled farm name before it enters the
      // email subject — defense-in-depth against header injection.
      const safeFarmName = farmName.replace(/[\r\n]+/g, ' ').trim();
      const subject = (phase === 'received'
        ? `Получихме поръчката ти — ${safeFarmName}`
        : `Поръчката ти е потвърдена — ${safeFarmName}`
      ).trim();

      await this.email.sendMail({
        to,
        subject,
        html: this.renderHtml(order, items, farmName, phase),
        text: this.renderText(order, items, farmName, phase),
        stream: 'transactional',
      });
    } catch (err) {
      this.logger.error(
        `order-${phase} email failed for ${orderId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /** Attach each line's product cover photo (gallery position 0, else legacy imageUrl) + tint. */
  private async withImages(
    rows: {
      productId: string | null;
      name: string | null;
      quantity: number;
      priceStotinki: number;
    }[],
  ): Promise<EmailItem[]> {
    const ids = rows.map((r) => r.productId).filter((x): x is string => !!x);
    const img = new Map<string, string>();
    const tint = new Map<string, string | null>();
    if (ids.length) {
      const prods = await this.db
        .select({ id: products.id, imageUrl: products.imageUrl, tint: products.tint })
        .from(products)
        .where(inArray(products.id, ids));
      for (const p of prods) {
        if (p.imageUrl) img.set(p.id, p.imageUrl);
        tint.set(p.id, p.tint);
      }
      // Gallery cover fills in any product whose legacy imageUrl is empty.
      const media = await this.db
        .select({ productId: productMedia.productId, url: productMedia.url })
        .from(productMedia)
        .where(inArray(productMedia.productId, ids))
        .orderBy(asc(productMedia.position));
      for (const m of media) {
        if (m.productId && !img.has(m.productId)) img.set(m.productId, m.url);
      }
    }
    return rows.map((r) => ({
      name: r.name ?? '',
      quantity: r.quantity,
      priceStotinki: r.priceStotinki,
      imageUrl: r.productId ? img.get(r.productId) ?? null : null,
      tint: r.productId ? tint.get(r.productId) ?? null : null,
    }));
  }

  /** Human delivery line: method + office code or street/city. */
  private deliveryLine(order: OrderRow): string {
    const label = DELIVERY_LABELS[order.deliveryType ?? 'address'] ?? 'Доставка';
    let where = '';
    if (order.deliveryType === 'econt' && order.econtOffice) {
      where = `офис ${order.econtOffice}`;
    } else if (order.deliveryAddress) {
      where = [order.deliveryAddress, order.deliveryCity].filter(Boolean).join(', ');
    } else if (order.deliveryCity) {
      where = order.deliveryCity;
    }
    return where ? `${label} — ${where}` : label;
  }

  private renderHtml(order: OrderRow, items: EmailItem[], farmName: string, phase: 'received' | 'confirmed'): string {
    const subtotal = items.reduce((s, it) => s + it.priceStotinki * it.quantity, 0);
    const total = order.totalStotinki ?? subtotal;
    const shipping = Math.max(0, total - subtotal);

    const itemRows = items
      .map((it) => {
        const lineTotal = it.priceStotinki * it.quantity;
        const thumb = it.imageUrl
          ? `<img src="${esc(it.imageUrl)}" width="56" height="56" alt="" style="display:block;width:56px;height:56px;border-radius:10px;object-fit:cover;border:1px solid #e7e3d6">`
          : `<div style="width:56px;height:56px;border-radius:10px;background:${esc(it.tint ?? '#2d6a4f')}"></div>`;
        return `
        <tr>
          <td style="padding:10px 0;width:56px;vertical-align:top">${thumb}</td>
          <td style="padding:10px 12px;font-size:14px;color:#23210f;vertical-align:top">
            <div style="font-weight:bold">${esc(it.name)}</div>
            <div style="color:#8a8770;font-size:13px;margin-top:2px">${it.quantity} × ${money(it.priceStotinki)}</div>
          </td>
          <td style="padding:10px 0;text-align:right;font-size:14px;font-weight:bold;color:#23210f;white-space:nowrap;vertical-align:top">${money(lineTotal)}</td>
        </tr>`;
      })
      .join('');

    const totalsRow = (label: string, value: string, strong = false) => `
        <tr>
          <td style="padding:4px 0;font-size:${strong ? '16px' : '14px'};color:${strong ? '#23210f' : '#4a4733'};${strong ? 'font-weight:bold;border-top:1px solid #eee7d6;padding-top:10px' : ''}">${esc(label)}</td>
          <td style="padding:4px 0;text-align:right;font-size:${strong ? '16px' : '14px'};color:${strong ? '#2d6a4f' : '#4a4733'};${strong ? 'font-weight:bold;border-top:1px solid #eee7d6;padding-top:10px' : ''};white-space:nowrap">${esc(value)}</td>
        </tr>`;

    const greetingName = order.customerName ? esc(order.customerName) : '';

    return `<!doctype html><html lang="bg"><body style="margin:0;background:#f6f4ec;font-family:Arial,Helvetica,sans-serif;color:#23210f">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f4ec;padding:28px 0">
    <tr><td align="center">
      <table role="presentation" width="520" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fffdf7;border:1px solid #e7e3d6;border-radius:16px;overflow:hidden">
        <tr><td style="background:#2d6a4f;padding:22px 28px;color:#eaf1e4;font-size:20px;font-weight:bold">🌿 ${esc(farmName)}</td></tr>
        <tr><td style="padding:28px">
          <h1 style="margin:0 0 6px;font-size:22px;color:#23210f">Благодарим за поръчката!</h1>
          <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#4a4733">
            ${greetingName ? `Здравей, ${greetingName}! ` : ''}${
              phase === 'received'
                ? '<strong>Получихме поръчката ти!</strong> Ще се свържем по телефона, ако трябва да уточним нещо, и ще ти пишем пак, щом я потвърдим.'
                : 'Поръчката ти е <strong>потвърдена</strong> и вече я приготвяме.'
            }
          </p>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">
            ${itemRows}
          </table>

          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:14px">
            ${totalsRow('Продукти', money(subtotal))}
            ${shipping > 0 ? totalsRow('Доставка', money(shipping)) : ''}
            ${totalsRow('Общо', money(total), true)}
          </table>

          <div style="margin-top:22px;padding:14px 16px;background:#f3f6f0;border:1px solid #e1e9dd;border-radius:12px">
            <div style="font-size:12px;letter-spacing:.04em;text-transform:uppercase;color:#8a8770;margin-bottom:4px">Доставка</div>
            <div style="font-size:14px;color:#23210f">${esc(this.deliveryLine(order))}</div>
          </div>

          <p style="margin:22px 0 0">
            <a href="${esc(this.storefrontUrl)}/confirmation?order=${esc(order.id)}" style="display:inline-block;background:#2d6a4f;color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px;padding:12px 20px;border-radius:10px">Виж поръчката</a>
          </p>
        </td></tr>
        <tr><td style="padding:16px 28px;border-top:1px solid #eee7d6;font-size:12px;color:#a8a594">${esc(farmName)} · Благодарим, че пазаруваш от местни производители 🌱</td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
  }

  private renderText(order: OrderRow, items: EmailItem[], farmName: string, phase: 'received' | 'confirmed'): string {
    const subtotal = items.reduce((s, it) => s + it.priceStotinki * it.quantity, 0);
    const total = order.totalStotinki ?? subtotal;
    const shipping = Math.max(0, total - subtotal);
    const lines = items.map(
      (it) => `- ${it.name} × ${it.quantity} = ${money(it.priceStotinki * it.quantity)}`,
    );
    return [
      phase === 'received'
        ? `${farmName} — Получихме поръчката ти.`
        : `${farmName} — Поръчката ти е потвърдена.`,
      order.customerName ? `Здравей, ${order.customerName}!` : '',
      '',
      ...lines,
      '',
      `Продукти: ${money(subtotal)}`,
      shipping > 0 ? `Доставка: ${money(shipping)}` : '',
      `Общо: ${money(total)}`,
      '',
      this.deliveryLine(order),
    ]
      .filter((l) => l !== '')
      .join('\n');
  }
}
