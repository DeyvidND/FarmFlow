import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, gte, inArray, lte } from 'drizzle-orm';
import { type Database, manualExpenses, tenants, users } from '@fermeribg/db';
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

  /** Спецификацията изисква куриерът да е реален driver/admin акаунт на СЪЩИЯ
   *  наемател — иначе собственик може да закачи разход към чужд/несъществуващ
   *  UUID (не е дупка в изолацията, защото P&L заявката пак е tenant-scoped и
   *  такъв запис просто пада на „Куриер" в разбивката, но е дупка в целостта). */
  private async assertCourierAccount(tenantId: string, courierAccountId: string): Promise<void> {
    const [row] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          eq(users.id, courierAccountId),
          eq(users.tenantId, tenantId),
          inArray(users.role, ['driver', 'admin']),
        ),
      )
      .limit(1);
    if (!row) throw new BadRequestException('Невалиден куриер за тази ферма.');
  }

  async create(tenantId: string, userId: string, dto: CreateExpenseDto): Promise<{ id: string }> {
    if (dto.courierAccountId != null) {
      await this.assertCourierAccount(tenantId, dto.courierAccountId);
    }
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
    // `null` е валидна цел: отвързва разхода от куриер. Валидираме само когато
    // полето наистина се задава на непразна стойност — не при отсъствие/null.
    if ('courierAccountId' in dto) {
      if (dto.courierAccountId != null) await this.assertCourierAccount(tenantId, dto.courierAccountId);
      patch.courierAccountId = dto.courierAccountId ?? null;
    }
    // `null` е валидна цел: изчиства бележката. `'note' in dto`, не `!== undefined`
    // — иначе изричен `null` (изтрий бележката) не се различава от „непроменена".
    if ('note' in dto) patch.note = dto.note ?? null;

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
