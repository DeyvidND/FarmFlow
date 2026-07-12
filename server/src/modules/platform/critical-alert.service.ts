import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type Redis from 'ioredis';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';
import { EmailService } from '../../common/email/email.service';
import { ProblemsService, type PlatformProblem } from './problems.service';

export type CriticalAlertResult =
  | { sent: true; count: number }
  | { sent: false; reason: 'no-recipient' | 'none-critical' | 'no-new' };

// The check now runs twice daily (07:00 / 19:00 Europe/Sofia — see
// CriticalAlertProcessor), not every 15 minutes. This cooldown only dedupes
// within a single run — e.g. a BullMQ job retry or a manual re-trigger via
// POST /platform/critical-alert-test hitting checkAndAlert() twice in quick
// succession — while staying well under the ~12h gap between scheduled runs.
// So each of the two daily runs still re-alerts any still-unresolved problem;
// the only way to silence it is for an operator to mark it resolved in
// «Проблеми» (ProblemsService then excludes it from `items` entirely).
const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6h

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class CriticalAlertService {
  private readonly logger = new Logger(CriticalAlertService.name);

  constructor(
    @Inject(REDIS_TOKEN) private readonly redis: Redis,
    private readonly config: ConfigService,
    private readonly email: EmailService,
    private readonly problems: ProblemsService,
  ) {}

  /** Checks the "Проблеми" feed for high-severity items and emails any that
   *  haven't already been alerted within the cooldown window. Called twice daily
   *  (07:00 / 19:00 Europe/Sofia) by CriticalAlertProcessor; safe to call manually
   *  (e.g. for a test trigger) — dedup is keyed in Redis, not in-memory. */
  async checkAndAlert(): Promise<CriticalAlertResult> {
    const to = this.config.get<string>('CRITICAL_ALERT_EMAIL');
    if (!to) {
      this.logger.warn('[critical-alert] CRITICAL_ALERT_EMAIL not set — skipping');
      return { sent: false, reason: 'no-recipient' };
    }

    const { items } = await this.problems.problems();
    // `empty_shop` (a farm with zero active products) is severity:'high' in the
    // Проблеми panel, but it's a slow-moving onboarding issue, not an acute
    // failure — it's already surfaced in the daily operator digest, so emailing
    // it here would just be a redundant, lower-urgency duplicate. Only genuinely
    // acute problems (server errors) page immediately.
    const critical = items.filter((p) => p.severity === 'high' && p.kind !== 'empty_shop');
    if (!critical.length) return { sent: false, reason: 'none-critical' };

    const fresh: PlatformProblem[] = [];
    for (const p of critical) {
      const key = `critical-alert:sent:${p.kind}:${p.tenantId ?? 'platform'}`;
      const claimed = await this.redis.set(key, '1', 'PX', ALERT_COOLDOWN_MS, 'NX');
      if (claimed === 'OK') fresh.push(p);
    }
    if (!fresh.length) return { sent: false, reason: 'no-new' };

    const adminUrl = this.config.get<string>('ADMIN_PANEL_URL') || 'https://admin.fermeribg.com';
    const html = this.render(fresh, adminUrl);
    const text = fresh
      .map((p) => `${p.title} — ${p.tenantName ?? '(платформа)'}: ${p.detail}`)
      .join('\n');
    await this.email.sendMail({
      to,
      subject: `⚠ ${fresh.length} критичен проблем${fresh.length === 1 ? '' : 'а'} — ФермериБГ`,
      html,
      text,
    });
    this.logger.log(`[critical-alert] sent ${fresh.length} new critical problem(s) to ${to}`);
    return { sent: true, count: fresh.length };
  }

  /** Branded HTML email — mirrors the visual style of operator-digest.render.ts
   *  (Arial, #2d6a4f green header/rule, bordered rounded cards, 600px max-width). */
  private render(items: PlatformProblem[], adminUrl: string): string {
    const itemsHtml = items
      .map(
        (p) => `
        <div style="margin:0 0 12px;padding:10px 12px;border:1px solid #eee;border-radius:8px">
          <div style="font-weight:bold">${escapeHtml(p.title)} <span style="font-weight:normal;color:#2d6a4f">${escapeHtml(p.tenantName ?? '(платформа)')}</span></div>
          <div style="font-size:14px;color:#555;margin-top:4px">${escapeHtml(p.detail)}</div>
        </div>`,
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="bg">
<head><meta charset="UTF-8"><title>Критичен проблем — ФермериБГ</title></head>
<body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333">
  <h1 style="font-size:20px;color:#2d6a4f;border-bottom:2px solid #2d6a4f;padding-bottom:8px">⚠ Критични проблеми (${items.length})</h1>
  ${itemsHtml}
  <p style="margin:24px 0">
    <a href="${adminUrl}/problems" style="display:inline-block;background:#2d6a4f;color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-size:14px">Виж в „Проблеми"</a>
  </p>
  <p style="font-size:12px;color:#999;margin-top:32px">ФермериБГ — автоматично известие за критичен проблем</p>
</body>
</html>`;
  }
}
