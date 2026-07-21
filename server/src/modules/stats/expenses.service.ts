import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, lte } from 'drizzle-orm';
import { type Database, manualExpenses, tenants } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { jsonbDeepMerge } from '../../common/db/jsonb';
import { INFO_COMMISSION_PATH } from './stats.settings';
import type { CreateExpenseDto, UpdateExpenseDto } from './dto/expense.dto';

export interface ExpenseRow {
  id: string;
  date: string;
  amountStotinki: number;
  category: string;
  courierAccountId: string | null;
  note: string | null;
}

/**
 * Ръчните разходи на фермата. Всеки write стеснява по `tenant_id` И по `id` —
 * `id`-ът идва от URL-а, така че само проверка по него би позволил писане през
 * граница на наемател. Нулев засегнат ред → 404, не мълчалив успех.
 */
@Injectable()
export class ExpensesService {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  async list(tenantId: string, from: string, to: string): Promise<ExpenseRow[]> {
    return this.db
      .select({
        id: manualExpenses.id,
        date: manualExpenses.date,
        amountStotinki: manualExpenses.amountStotinki,
        category: manualExpenses.category,
        courierAccountId: manualExpenses.courierAccountId,
        note: manualExpenses.note,
      })
      .from(manualExpenses)
      .where(
        and(
          eq(manualExpenses.tenantId, tenantId),
          gte(manualExpenses.date, from),
          lte(manualExpenses.date, to),
        ),
      )
      .orderBy(desc(manualExpenses.date), desc(manualExpenses.createdAt));
  }

  async create(tenantId: string, userId: string, dto: CreateExpenseDto): Promise<{ id: string }> {
    const [row] = await this.db
      .insert(manualExpenses)
      .values({
        tenantId,
        date: dto.date,
        amountStotinki: dto.amountStotinki,
        category: dto.category,
        courierAccountId: dto.courierAccountId ?? null,
        note: dto.note ?? null,
        createdById: userId,
      })
      .returning({ id: manualExpenses.id });
    return { id: row.id };
  }

  async update(tenantId: string, id: string, dto: UpdateExpenseDto): Promise<{ id: string }> {
    const patch: Record<string, unknown> = {};
    if (dto.date !== undefined) patch.date = dto.date;
    if (dto.amountStotinki !== undefined) patch.amountStotinki = dto.amountStotinki;
    if (dto.category !== undefined) patch.category = dto.category;
    // `null` е валидна цел: отвързва разхода от куриер.
    if ('courierAccountId' in dto) patch.courierAccountId = dto.courierAccountId ?? null;
    if (dto.note !== undefined) patch.note = dto.note ?? null;

    const [row] = await this.db
      .update(manualExpenses)
      .set(patch)
      .where(and(eq(manualExpenses.tenantId, tenantId), eq(manualExpenses.id, id)))
      .returning({ id: manualExpenses.id });
    if (!row) throw new NotFoundException('Разходът не е намерен');
    return { id: row.id };
  }

  async remove(tenantId: string, id: string): Promise<{ ok: true }> {
    const [row] = await this.db
      .delete(manualExpenses)
      .where(and(eq(manualExpenses.tenantId, tenantId), eq(manualExpenses.id, id)))
      .returning({ id: manualExpenses.id });
    if (!row) throw new NotFoundException('Разходът не е намерен');
    return { ok: true };
  }

  /** Пише процента атомарно в `settings`. `jsonbDeepMerge`, а не read-modify-write:
   *  паралелен запис по друг път в blob-а не бива да губи чужди ключове. */
  async setCommissionBps(tenantId: string, bps: number): Promise<{ bps: number }> {
    await this.db
      .update(tenants)
      .set({ settings: jsonbDeepMerge(tenants.settings, [...INFO_COMMISSION_PATH], bps) })
      .where(eq(tenants.id, tenantId));
    return { bps };
  }
}
