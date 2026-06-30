import { Injectable, Inject, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, gte, sql } from 'drizzle-orm';
import { type Database, tenants, orders } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { EmailService } from '../../common/email/email.service';
import { bgToday } from '../../common/time/bg-time';
import { PlatformInsightsService } from './insights.service';
import { PlatformService } from './platform.service';
import { assembleDigest } from './operator-digest.render';

interface DailyPulse {
  orders24h: number;
  revenue24hStotinki: number;
  newSignups: { name: string; createdAt: Date | null }[];
}

export type RunDailyResult = { sent: true } | { sent: false; reason: 'no-recipient' | 'empty' };

@Injectable()
export class OperatorDigestService {
  private readonly logger = new Logger(OperatorDigestService.name);

  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly insights: PlatformInsightsService,
    private readonly platform: PlatformService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /** New signups + order/revenue pulse over the last 24h (demo tenants excluded). */
  private async dailyPulse(): Promise<DailyPulse> {
    const notDemo = sql`${orders.tenantId} in (select ${tenants.id} from ${tenants} where ${tenants.isDemo} = false)`;
    const [pulseRow] = await this.db
      .select({
        orders24h: sql<number>`count(*)::int`,
        revenue24hStotinki: sql<number>`coalesce(sum(${orders.totalStotinki}) filter (where ${orders.status} is distinct from 'cancelled'), 0)::int`,
      })
      .from(orders)
      .where(and(gte(orders.createdAt, sql`now() - interval '24 hours'`), notDemo));

    const signupRows = await this.db
      .select({ name: tenants.name, createdAt: tenants.createdAt })
      .from(tenants)
      .where(and(sql`${tenants.isDemo} = false`, gte(tenants.createdAt, sql`now() - interval '24 hours'`)))
      .orderBy(tenants.createdAt);

    return {
      orders24h: pulseRow?.orders24h ?? 0,
      revenue24hStotinki: pulseRow?.revenue24hStotinki ?? 0,
      newSignups: signupRows,
    };
  }

  /** Build + send today's operator digest. Skips on no recipient or a quiet day. */
  async runDaily(): Promise<RunDailyResult> {
    const to = this.config.get<string>('SUPER_ADMIN_EMAIL');
    if (!to) {
      this.logger.warn('[operator-digest] SUPER_ADMIN_EMAIL not set — skipping');
      return { sent: false, reason: 'no-recipient' };
    }

    const [insights, deliveryOps, billing, pulse] = await Promise.all([
      this.insights.insights(),
      this.platform.deliveryOps(),
      this.platform.emailBilling(),
      this.dailyPulse(),
    ]);

    const { html, text, isEmpty } = assembleDigest(
      {
        pulse,
        signals: insights.signals.map((f) => ({
          name: f.name,
          phone: f.phone,
          signals: f.signals.map((s) => ({ label: s.label, action: s.action })),
        })),
        stuckDrafts: deliveryOps.stuckDrafts.map((d) => ({
          farmerName: d.farmerName,
          tenantName: d.tenantName,
          count: d.count,
          oldestAt: d.oldestAt,
        })),
        emailTotals: {
          recipientTotal: billing.totals.recipientTotal,
          revenueStotinki: billing.totals.revenueStotinki,
          marginStotinki: billing.totals.marginStotinki,
        },
      },
      bgToday(),
    );

    if (isEmpty) {
      this.logger.log('[operator-digest] quiet day — skipping send');
      return { sent: false, reason: 'empty' };
    }

    await this.email.sendMail({ to, subject: 'Дневен отчет — ФермериБГ', html, text });
    this.logger.log(`[operator-digest] sent to ${to}`);
    return { sent: true };
  }
}
