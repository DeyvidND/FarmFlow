import { BadGatewayException, BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import sharp from 'sharp';

/** A clean product row ready for PlatformImportDto.products (subset of CreateProductDto). */
export interface ExtractedProduct {
  name: string;
  priceStotinki: number;
  unit: string;
  weight?: string;
  category?: string;
  description?: string;
  isActive: true;
}

const MAX_TEXT = 100_000;
const MAX_ROWS = 1000;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME_RE = /^image\/(jpeg|png|webp)$/;

/** True when the upload is a photo the vision path should handle. */
export function isImageFile(file: Express.Multer.File): boolean {
  return IMAGE_MIME_RE.test(file.mimetype ?? '');
}

const SYSTEM_PROMPT = `Ти си помощник, който извлича продукти от ценоразпис на българска ферма.
Текстът по-долу е приблизително подреден по полета: име, цена, мерна единица, разфасовка, категория, описание.
Извади ВСЕКИ продукт. За всеки върни:
- name: име на продукта на български.
- priceStotinki: цена в стотинки (евроцентове) като ЦЯЛО число. Десетична цена × 100, закръгли. „6,50" → 650, „12" → 1200.
- unit: мерна единица („кг", „бр", „връзка", „литър", „пакет"…). Ако липсва — „бр".
- weight: разфасовка/тегло ако е дадено, иначе празен низ.
- category: раздел/категория ако личи, иначе празен низ.
- description: кратко описание ако има, иначе празен низ.
Пропусни редове, които не са продукти (заглавия, телефони, адреси, имейли).
Връщай само JSON: {"products":[{"name","priceStotinki","unit","weight","category","description"}]}. Без друг текст.`;

/** Coerce one raw model row into a clean product, or null to drop it. */
function coerce(r: unknown): ExtractedProduct | null {
  if (!r || typeof r !== 'object') return null;
  const o = r as Record<string, unknown>;
  const name = typeof o.name === 'string' ? o.name.trim() : '';
  if (!name) return null;
  let price = Number(o.priceStotinki);
  if (!Number.isFinite(price) || price < 0) price = 0;
  price = Math.round(price);
  const unit = typeof o.unit === 'string' && o.unit.trim() ? o.unit.trim() : 'бр';
  const out: ExtractedProduct = { name, priceStotinki: price, unit, isActive: true };
  const weight = typeof o.weight === 'string' ? o.weight.trim() : '';
  const category = typeof o.category === 'string' ? o.category.trim() : '';
  const description = typeof o.description === 'string' ? o.description.trim() : '';
  if (weight) out.weight = weight;
  if (category) out.category = category;
  if (description) out.description = description;
  return out;
}

@Injectable()
export class ProductExtractService {
  private readonly log = new Logger(ProductExtractService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('OPENAI_API_KEY');
    // Bound the call: a foreground operator action shouldn't hang on a slow OpenAI.
    this.client = key ? new OpenAI({ apiKey: key, timeout: 30_000, maxRetries: 1 }) : null;
    this.model = config.get<string>('OPENAI_IMPORT_MODEL', 'gpt-4o-mini') ?? 'gpt-4o-mini';
  }

  /** Pasted text wins; otherwise decode the file (.txt/.csv direct, .xlsx via exceljs). */
  async parseToText(file: Express.Multer.File | undefined, text: string | undefined): Promise<string> {
    if (text && text.trim()) return text.slice(0, MAX_TEXT);
    if (!file) throw new BadRequestException('Подайте текст или файл');
    const name = (file.originalname ?? '').toLowerCase();
    const mt = file.mimetype ?? '';
    if (name.endsWith('.txt') || name.endsWith('.csv') || mt.startsWith('text/')) {
      return file.buffer.toString('utf8').slice(0, MAX_TEXT);
    }
    if (name.endsWith('.xlsx') || mt.includes('spreadsheet')) {
      const ExcelJS = await import('exceljs');
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(file.buffer);
      const lines: string[] = [];
      wb.eachSheet((ws) => {
        ws.eachRow((row) => {
          const cells = (row.values as unknown[]).slice(1).map((v) => {
            if (v == null) return '';
            if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) return String((v as { text: unknown }).text);
            return String(v);
          });
          lines.push(cells.join('\t'));
        });
      });
      return lines.join('\n').slice(0, MAX_TEXT);
    }
    throw new BadRequestException('Неподдържан файл — .txt, .csv или .xlsx');
  }

  /** Extract products from prepared text. Throws (no silent degrade) — operator can retry. */
  async extract(text: string): Promise<ExtractedProduct[]> {
    if (!this.client) throw new ServiceUnavailableException('AI импорт не е конфигуриран');
    let raw: string;
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
        ],
      });
      raw = res.choices[0]?.message?.content ?? '{}';
    } catch (e) {
      this.log.warn(`OpenAI product extract failed: ${String((e as Error)?.message ?? e)}`);
      throw new BadGatewayException('AI услугата не отговори — опитайте пак');
    }
    return this.parseCompletion(raw);
  }

  /** Parse one completion's raw content into clean rows (shared by text + vision). */
  private parseCompletion(raw: string | null | undefined): ExtractedProduct[] {
    let parsed: { products?: unknown };
    try {
      parsed = JSON.parse(raw ?? '{}');
    } catch {
      throw new BadGatewayException('AI върна невалиден отговор — опитайте пак');
    }
    const rows = Array.isArray(parsed.products) ? parsed.products : [];
    return rows.map(coerce).filter((p): p is ExtractedProduct => p != null).slice(0, MAX_ROWS);
  }

  /**
   * Vision path: a PHOTO of a price list (paper/handwritten) → product rows.
   * Downscaled before sending — vision cost scales with pixels and 1600px is
   * plenty for OCR. Same prompt + coercion as the text path.
   */
  async extractFromImage(file: Express.Multer.File): Promise<ExtractedProduct[]> {
    if (!this.client) {
      throw new ServiceUnavailableException('AI импортът не е настроен (липсва OPENAI_API_KEY).');
    }
    if (!isImageFile(file)) throw new BadRequestException('Подайте снимка (JPEG/PNG/WebP).');
    if (file.size > MAX_IMAGE_BYTES) {
      throw new BadRequestException('Снимката е твърде голяма (до 10MB). Снимайте отново или я компресирайте.');
    }
    // .rotate() honours EXIF orientation — phone photos are often sideways.
    const jpeg = await sharp(file.buffer)
      .rotate()
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    const dataUri = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Извади продуктите от този ценоразпис (снимка).' },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
      });
      return this.parseCompletion(res.choices[0]?.message?.content);
    } catch (e) {
      this.log.warn(`OpenAI image extract failed: ${String((e as Error)?.message ?? e)}`);
      throw new BadGatewayException('AI разчитането на снимката не успя. Опитайте пак или поставете текста.');
    }
  }
}
