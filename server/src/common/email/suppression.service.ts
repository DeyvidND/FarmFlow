import { Injectable, Inject, Logger } from '@nestjs/common';
import { inArray, eq } from 'drizzle-orm';
import { type Database, emailSuppressions } from '@farmflow/db';
import { DB_TOKEN } from '../drizzle/drizzle.constants';

export type SuppressionReason = 'bounce' | 'complaint' | 'manual';

/**
 * Global email do-not-send list. Hard bounces and spam complaints (fed by the SES
 * webhook) land here; every send checks it first so a bad address can't keep
 * hurting the shared sending domain's reputation.
 */
@Injectable()
export class SuppressionService {
  private readonly logger = new Logger(SuppressionService.name);

  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async isSuppressed(email: string): Promise<boolean> {
    const norm = email.trim().toLowerCase();
    if (!norm) return false;
    const [row] = await this.db
      .select({ id: emailSuppressions.id })
      .from(emailSuppressions)
      .where(eq(emailSuppressions.email, norm))
      .limit(1);
    return !!row;
  }

  /** Returns the subset of `emails` that are suppressed (lower-cased). */
  async filterSuppressed(emails: string[]): Promise<Set<string>> {
    const norm = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (norm.length === 0) return new Set();
    const rows = await this.db
      .select({ email: emailSuppressions.email })
      .from(emailSuppressions)
      .where(inArray(emailSuppressions.email, norm));
    return new Set(rows.map((r) => r.email));
  }

  async suppress(email: string, reason: SuppressionReason, detail?: string): Promise<void> {
    const norm = email.trim().toLowerCase();
    if (!norm) return;
    await this.db
      .insert(emailSuppressions)
      .values({ email: norm, reason, detail: detail ?? null })
      .onConflictDoNothing({ target: emailSuppressions.email });
    this.logger.log(`[suppression] +${norm} (${reason})`);
  }
}
