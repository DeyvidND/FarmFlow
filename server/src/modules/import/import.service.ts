import { BadRequestException, Injectable, NotFoundException, Inject } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { type Database, importBatches, importRows } from '@fermeribg/db';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { parseFile } from './import.parse';
import { normalizeRow } from './import.normalize';
import { validateRow } from './import.validate';
import { mergeAi, ImportAiService } from './import.ai';
import { ImportResolveService } from './import.resolve';
import type { BatchDefaults, NormalizedRow, RowStatus } from './import.types';
import { ImportSettingsDto } from './dto/import-settings.dto';

const MAX_ROWS = 200;

@Injectable()
export class ImportService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly ai: ImportAiService,
    private readonly resolver: ImportResolveService,
  ) {}

  /** Parse + validate + resolve + AI-check an uploaded file → a persisted draft batch. */
  async createBatch(tenantId: string, file: { buffer: Buffer; originalname: string }, settings: ImportSettingsDto) {
    if (!file?.buffer?.length) throw new BadRequestException('Празен файл');
    if (!/\.(xlsx|csv)$/i.test(file.originalname)) {
      throw new BadRequestException('Поддържат се само .xlsx и .csv файлове');
    }
    const raw = await parseFile(file.buffer, file.originalname);
    if (!raw.length) throw new BadRequestException('Файлът няма редове с данни');
    if (raw.length > MAX_ROWS) throw new BadRequestException(`Максимум ${MAX_ROWS} реда на файл (${raw.length} намерени)`);

    const defaults: BatchDefaults = {
      carrier: settings.carrier,
      currency: settings.currency,
      weightGrams: settings.weightGrams,
      contents: settings.contents,
      codProcessingType: settings.codProcessingType,
      speedyServiceId: settings.speedyServiceId,
    };
    const normalized = raw.map((r, i) => normalizeRow(r, i + 1, defaults));

    const verdicts = await this.ai.review(normalized);
    const verdictByIndex = new Map(verdicts.map((v) => [v.index, v]));

    const counts: Record<RowStatus, number> = { ok: 0, warn: 0, error: 0 };
    const rowsToInsert: (typeof importRows.$inferInsert)[] = [];
    const [batch] = await this.db
      .insert(importBatches)
      .values({
        tenantId,
        fileName: file.originalname,
        carrierDefault: settings.carrier,
        currency: settings.currency,
        status: 'validating',
        settings: defaults as unknown as Record<string, unknown>,
      })
      .returning();

    for (const row of normalized) {
      const det = validateRow(row);
      const resolved = det.status === 'error'
        ? { refs: {}, ambiguous: false, unresolved: null as string | null }
        : await this.resolver.resolve(tenantId, row);
      let validation = mergeAi(det, verdictByIndex.get(row.rowIndex));
      if (resolved.ambiguous || resolved.unresolved) {
        const status: RowStatus = validation.status === 'error' ? 'error' : 'warn';
        validation = {
          status,
          issues: [...validation.issues, {
            field: resolved.unresolved ?? 'city',
            message: resolved.ambiguous ? 'Няколко съвпадения — избери' : 'Не е намерено — провери',
          }],
        };
      }
      counts[validation.status]++;
      rowsToInsert.push(this.toRowInsert(batch.id, tenantId, row, validation, resolved.refs));
    }

    await this.db.insert(importRows).values(rowsToInsert);
    const aiReport = { aiAvailable: this.ai.available, ...counts };
    await this.db.update(importBatches)
      .set({ status: 'ready', aiReport })
      .where(and(eq(importBatches.id, batch.id), eq(importBatches.tenantId, tenantId)));

    return this.getBatch(tenantId, batch.id);
  }

  private toRowInsert(
    batchId: string, tenantId: string, row: NormalizedRow,
    validation: { status: RowStatus; issues: unknown[] }, refs: Record<string, unknown>,
  ): typeof importRows.$inferInsert {
    return {
      batchId, tenantId, rowIndex: row.rowIndex, raw: row.raw as Record<string, unknown>,
      receiverName: row.receiverName, receiverPhone: row.receiverPhone,
      deliveryMode: row.deliveryMode, city: row.city, office: row.office,
      address: row.address, streetNo: row.streetNo, weightGrams: row.weightGrams,
      contents: row.contents, codAmountStotinki: row.codAmountStotinki,
      declaredValueStotinki: row.declaredValueStotinki, carrier: row.carrier,
      validationStatus: validation.status, validation: { issues: validation.issues } as Record<string, unknown>,
      resolvedRefs: refs,
    };
  }

  /** Fetch a batch + its rows (tenant-scoped). */
  async getBatch(tenantId: string, batchId: string) {
    const [batch] = await this.db.select().from(importBatches)
      .where(and(eq(importBatches.id, batchId), eq(importBatches.tenantId, tenantId))).limit(1);
    if (!batch) throw new NotFoundException('Партидата не е намерена');
    const rows = await this.db.select().from(importRows)
      .where(and(eq(importRows.batchId, batchId), eq(importRows.tenantId, tenantId)))
      .orderBy(importRows.rowIndex);
    return { batch, rows };
  }
}
