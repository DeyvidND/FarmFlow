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
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';

const MAX_ROWS = 200;

@Injectable()
export class ImportService {
  constructor(
    @Inject(DB_TOKEN) private readonly db: Database,
    private readonly ai: ImportAiService,
    private readonly resolver: ImportResolveService,
    private readonly econtSvc: EcontService,
    private readonly speedySvc: SpeedyService,
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

    const CONCURRENCY = 8;
    const processRow = async (row: NormalizedRow) => {
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
      return { row, validation, refs: resolved.refs };
    };
    for (let i = 0; i < normalized.length; i += CONCURRENCY) {
      const chunk = normalized.slice(i, i + CONCURRENCY);
      const processed = await Promise.all(chunk.map(processRow));
      for (const p of processed) {
        counts[p.validation.status]++;
        rowsToInsert.push(this.toRowInsert(batch.id, tenantId, p.row, p.validation, p.refs));
      }
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

  /** Update editable fields of a draft row, then re-validate + re-resolve it. */
  async patchRow(tenantId: string, batchId: string, rowId: string, patch: import('./dto/patch-row.dto').PatchRowDto) {
    const [existing] = await this.db.select().from(importRows)
      .where(and(eq(importRows.id, rowId), eq(importRows.batchId, batchId), eq(importRows.tenantId, tenantId)))
      .limit(1);
    if (!existing) throw new NotFoundException('Редът не е намерен');

    // Apply only provided fields.
    const merged: NormalizedRow = {
      rowIndex: existing.rowIndex,
      receiverName: patch.receiverName ?? existing.receiverName ?? '',
      receiverPhone: patch.receiverPhone ?? existing.receiverPhone ?? '',
      deliveryMode: (patch.deliveryMode ?? existing.deliveryMode) as NormalizedRow['deliveryMode'],
      city: patch.city ?? existing.city ?? null,
      office: patch.office ?? existing.office ?? null,
      address: patch.address ?? existing.address ?? null,
      streetNo: patch.streetNo ?? existing.streetNo ?? null,
      weightGrams: patch.weightGrams ?? existing.weightGrams ?? null,
      contents: patch.contents ?? existing.contents ?? null,
      codAmountStotinki: patch.codAmountStotinki ?? existing.codAmountStotinki ?? null,
      declaredValueStotinki: patch.declaredValueStotinki ?? existing.declaredValueStotinki ?? null,
      carrier: (patch.carrier ?? existing.carrier) as NormalizedRow['carrier'],
      raw: (existing.raw as NormalizedRow['raw']) ?? {},
    };

    const det = validateRow(merged);
    // User-picked ids from the editor take priority over auto-resolution.
    const manualRefs: Record<string, unknown> = {};
    for (const k of ['siteId', 'officeId', 'streetId', 'econtOfficeCode'] as const) {
      if (patch[k] != null) manualRefs[k] = patch[k];
    }
    // Re-validation on a patch is deterministic-only (we intentionally do NOT re-run the
    // OpenAI check per edit — too costly); a prior AI-raised severity is not preserved.
    let refs: Record<string, unknown> = { ...manualRefs };
    let validation = det;
    if (det.status !== 'error') {
      // Always re-resolve from the (possibly edited) location fields so stale auto-refs
      // from a previous city/mode can't survive — then let any user-picked candidate id
      // win on top.
      const resolved = await this.resolver.resolve(tenantId, merged);
      refs = { ...resolved.refs, ...manualRefs };
      if (!Object.keys(manualRefs).length && (resolved.ambiguous || resolved.unresolved)) {
        validation = {
          status: 'warn',
          issues: [...det.issues, { field: resolved.unresolved ?? 'city', message: 'Провери локацията' }],
        };
      }
    }

    const [updated] = await this.db.update(importRows).set({
      receiverName: merged.receiverName, receiverPhone: merged.receiverPhone,
      deliveryMode: merged.deliveryMode, city: merged.city, office: merged.office,
      address: merged.address, streetNo: merged.streetNo, weightGrams: merged.weightGrams,
      contents: merged.contents, codAmountStotinki: merged.codAmountStotinki,
      declaredValueStotinki: merged.declaredValueStotinki, carrier: merged.carrier,
      validationStatus: validation.status,
      validation: { issues: validation.issues } as unknown as Record<string, unknown>,
      resolvedRefs: refs as unknown as Record<string, unknown>,
    }).where(and(eq(importRows.id, rowId), eq(importRows.tenantId, tenantId))).returning();
    return updated;
  }

  /** Remove a draft row (tenant-scoped). */
  async deleteRow(tenantId: string, batchId: string, rowId: string) {
    const res = await this.db.delete(importRows)
      .where(and(eq(importRows.id, rowId), eq(importRows.batchId, batchId), eq(importRows.tenantId, tenantId)))
      .returning({ id: importRows.id });
    if (!res.length) throw new NotFoundException('Редът не е намерен');
    return { deleted: true };
  }

  /** Create real shipments for every committable row (ok, or warn the user accepted).
   *  Per-row try/catch → one failure is isolated; the rest still get created. */
  async commit(tenantId: string, batchId: string) {
    const { batch, rows } = await this.getBatch(tenantId, batchId);
    const speedyServiceId = (batch.settings as { speedyServiceId?: number } | null)?.speedyServiceId;

    const results: Array<{ rowId: string; status: 'created' | 'failed' | 'skipped'; shipmentId?: string; error?: string }> = [];
    for (const row of rows) {
      if (row.shipmentId) { results.push({ rowId: row.id, status: 'skipped' }); continue; }
      if (row.validationStatus === 'error') { results.push({ rowId: row.id, status: 'skipped' }); continue; }
      try {
        const shipmentId = row.carrier === 'speedy'
          ? await this.createSpeedy(tenantId, row, speedyServiceId)
          : await this.createEcont(tenantId, row);
        await this.db.update(importRows).set({ shipmentId, createStatus: 'created', createError: null })
          .where(and(eq(importRows.id, row.id), eq(importRows.tenantId, tenantId)));
        results.push({ rowId: row.id, status: 'created', shipmentId });
      } catch (e) {
        const error = String((e as Error)?.message ?? e).slice(0, 240);
        await this.db.update(importRows).set({ createStatus: 'failed', createError: error })
          .where(and(eq(importRows.id, row.id), eq(importRows.tenantId, tenantId)));
        results.push({ rowId: row.id, status: 'failed', error });
      }
    }

    const created = results.filter((r) => r.status === 'created').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    await this.db.update(importBatches).set({ status: failed ? 'partial' : 'done' })
      .where(and(eq(importBatches.id, batchId), eq(importBatches.tenantId, tenantId)));
    return { created, failed, results };
  }

  private async createEcont(tenantId: string, row: typeof importRows.$inferSelect): Promise<string> {
    const refs = (row.resolvedRefs as { econtOfficeCode?: string } | null) ?? {};
    // Only a resolved code (or an already-numeric office cell) is a valid Econt office code;
    // never pass a free-text office NAME as a code (it would silently fail at Econt).
    const officeCode = refs.econtOfficeCode ?? (row.office && /^\d{3,}$/.test(row.office) ? row.office : undefined);
    if (row.deliveryMode === 'office' && !officeCode) throw new Error('Неразпознат Еконт офис — провери офиса');
    const ship = await this.econtSvc.createManualShipment(tenantId, {
      receiverName: row.receiverName ?? '',
      receiverPhone: row.receiverPhone ?? '',
      deliveryMode: row.deliveryMode as 'office' | 'address',
      receiverOfficeCode: officeCode,
      receiverCity: row.city ?? undefined,
      receiverAddress: row.address ?? undefined,
      weightGrams: row.weightGrams ?? undefined,
      contents: row.contents ?? undefined,
      codAmountStotinki: row.codAmountStotinki ?? undefined,
      declaredValueStotinki: row.declaredValueStotinki ?? undefined,
    });
    return ship.id;
  }

  private async createSpeedy(tenantId: string, row: typeof importRows.$inferSelect, batchServiceId?: number): Promise<string> {
    const refs = (row.resolvedRefs as { siteId?: number; officeId?: number; streetId?: number } | null) ?? {};
    const serviceId = batchServiceId;
    if (!serviceId) throw new Error('Липсва Speedy serviceId за партидата');
    const ship = await this.speedySvc.createManualShipment(tenantId, {
      receiverName: row.receiverName ?? '',
      receiverPhone: row.receiverPhone ?? '',
      deliveryMode: row.deliveryMode as 'office' | 'address',
      officeId: refs.officeId,
      siteId: refs.siteId,
      streetId: refs.streetId,
      streetNo: row.streetNo ?? undefined,
      serviceId,
      weightGrams: row.weightGrams ?? undefined,
      contents: row.contents ?? undefined,
      codAmountStotinki: row.codAmountStotinki ?? undefined,
      declaredValueStotinki: row.declaredValueStotinki ?? undefined,
    });
    return ship.id;
  }
}
