import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import type { DraftProduct, DraftCopy } from './auto-draft.render';

const SYSTEM_PROMPT = `Ти си копирайтър за български фермерски магазин. Пишеш кратък седмичен бюлетин „какво е прясно".
Получаваш име на фермата и списък с продукти. Върни JSON:
{"subject": "...", "intro": "...", "blurbs": {"Име на продукт": "кратко описание до 12 думи"}}
- subject: кратко, примамливо заглавие на български (без емоджи спам).
- intro: 1–2 топли изречения, поздрав + покана да разгледат.
- blurbs: по едно кратко изречение за всеки продукт (ключът е ТОЧНО името на продукта).
Само JSON, без друг текст. Всичко на български.`;

@Injectable()
export class NewsletterCopyService {
  private readonly log = new Logger(NewsletterCopyService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('OPENAI_API_KEY');
    this.client = key ? new OpenAI({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;
    this.model = config.get<string>('OPENAI_IMPORT_MODEL', 'gpt-4o-mini') ?? 'gpt-4o-mini';
  }

  /** Deterministic copy when AI is unavailable — a plain newsletter beats none. */
  private fallback(farmName: string): DraftCopy {
    return { subject: `Свежи продукти от ${farmName}`, intro: 'Вижте какво предлагаме тази седмица.', blurbs: {} };
  }

  /** Write subject + intro + per-product blurbs. Never throws — fallback on any failure. */
  async writeCopy(farmName: string, products: DraftProduct[]): Promise<DraftCopy> {
    if (!this.client) return this.fallback(farmName);
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify({ farm: farmName, products: products.map((p) => p.name) }) },
        ],
      });
      const raw = res.choices[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(raw) as { subject?: unknown; intro?: unknown; blurbs?: unknown };
      const subject = typeof parsed.subject === 'string' && parsed.subject.trim() ? parsed.subject.trim() : this.fallback(farmName).subject;
      const intro = typeof parsed.intro === 'string' ? parsed.intro.trim() : '';
      const blurbs: Record<string, string> = {};
      if (parsed.blurbs && typeof parsed.blurbs === 'object') {
        for (const [k, v] of Object.entries(parsed.blurbs as Record<string, unknown>)) {
          if (typeof v === 'string' && v.trim()) blurbs[k] = v.trim();
        }
      }
      return { subject, intro, blurbs };
    } catch (e) {
      this.log.warn(`newsletter copy AI failed, using fallback: ${String((e as Error)?.message ?? e)}`);
      return this.fallback(farmName);
    }
  }
}
