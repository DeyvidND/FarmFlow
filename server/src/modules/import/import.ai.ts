import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { AiVerdict, NormalizedRow, RowStatus, RowValidation } from './import.types';

const SEVERITY: Record<RowStatus, number> = { ok: 0, warn: 1, error: 2 };

/** Combine deterministic validation with an AI verdict. Deterministic is authoritative:
 *  AI may raise severity (ok→warn→error) and add explanations, but cannot clear an error. */
export function mergeAi(det: RowValidation, ai: AiVerdict | undefined): RowValidation {
  if (!ai) return det;
  const status = SEVERITY[ai.status] > SEVERITY[det.status] ? ai.status : det.status;
  return { status, issues: [...det.issues, ...ai.issues] };
}

const SYSTEM_PROMPT = `Ти си помощник за проверка на таблица с пратки за български куриери (Еконт, Спиди).
За всеки ред върни JSON обект с: index (число), status ("ok"|"warn"|"error"), issues (масив от {field, message, suggestion?}).
Маркирай: липсващи задължителни полета, невалиден български телефон, неясен или непознат град, тип доставка който не пасва на дадените полета, нечислов наложен платеж.
Когато можеш да предложиш поправка, дай я в issue.suggestion и в normalized (частичен обект със същите ключове като реда).
Връщай само JSON: {"rows":[...]}. Без друг текст.`;

@Injectable()
export class ImportAiService {
  private readonly log = new Logger(ImportAiService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('OPENAI_API_KEY');
    // Bound the call: the SDK defaults to a 10-min timeout × 2 retries, which would
    // hang the upload request for ~30 min on a slow OpenAI before degrading to [].
    this.client = key ? new OpenAI({ apiKey: key, timeout: 8000, maxRetries: 1 }) : null;
    this.model = config.get<string>('OPENAI_IMPORT_MODEL', 'gpt-4o-mini') ?? 'gpt-4o-mini';
  }

  get available(): boolean {
    return this.client != null;
  }

  /** Ask OpenAI to vet the rows. Never throws — returns [] on any failure (degrade). */
  async review(rows: NormalizedRow[]): Promise<AiVerdict[]> {
    if (!this.client || !rows.length) return [];
    try {
      const payload = rows.map((r) => ({
        index: r.rowIndex,
        name: r.receiverName,
        phone: r.receiverPhone,
        mode: r.deliveryMode,
        city: r.city,
        office: r.office,
        address: r.address,
        cod: r.codAmountStotinki,
        carrier: r.carrier,
      }));
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ rows: payload }) },
        ],
      });
      const txt = res.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(txt) as { rows?: AiVerdict[] };
      return Array.isArray(parsed.rows) ? parsed.rows : [];
    } catch (e) {
      this.log.warn(`OpenAI import review failed, degrading: ${String((e as Error)?.message ?? e)}`);
      return [];
    }
  }
}
