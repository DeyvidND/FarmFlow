import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface ImageSanityVerdict {
  rotate: 0 | 90 | 180 | 270;
  /** Fractional box (0..1), relative to the image AS SENT to the model —
   *  applied against the full-resolution original BEFORE rotate. */
  cropBox?: { x: number; y: number; width: number; height: number };
  verdict: 'ok' | 'unusable';
  /** BG-facing reason, shown in the panel. */
  reason: string;
}

const SYSTEM_PROMPT = `Ти преглеждаш снимка на земеделски продукт (плод/зеленчук/храна), качена от фермер за
онлайн магазин. Автоматична проверка вече е отбелязала евентуален проблем — потвърди или отхвърли,
и предложи поправка ако е нужна.
Върни само JSON:
{"rotate": 0|90|180|270, "cropBox": {"x","y","width","height"} (дробни части 0..1, спрямо подадената снимка — само ако кадърът трябва да се изреже) или null, "verdict": "ok"|"unusable", "reason": "кратка причина на български"}
"unusable" само ако снимката е напълно неизползваема за магазин (напр. изцяло замъглена, случаен предмет, продуктът изобщо не се вижда).
Леко накриво или леко замъглено, но продуктът се разпознава ясно → "ok" с корекция (rotate/cropBox) или без.
Ако снимката вече е наред, върни rotate:0, cropBox:null, verdict:"ok".`;

function coerceVerdict(raw: string | null | undefined): ImageSanityVerdict | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw ?? '{}');
  } catch {
    return null;
  }
  const rotateRaw = Number(parsed.rotate);
  const rotate: ImageSanityVerdict['rotate'] = ([0, 90, 180, 270] as const).includes(
    rotateRaw as 0 | 90 | 180 | 270,
  )
    ? (rotateRaw as 0 | 90 | 180 | 270)
    : 0;
  const verdict: ImageSanityVerdict['verdict'] = parsed.verdict === 'unusable' ? 'unusable' : 'ok';
  const reason =
    typeof parsed.reason === 'string' && parsed.reason.trim() ? parsed.reason.trim().slice(0, 200) : 'без уточнение';

  let cropBox: ImageSanityVerdict['cropBox'];
  const cb = parsed.cropBox;
  if (cb && typeof cb === 'object') {
    const c = cb as Record<string, unknown>;
    const x = Number(c.x);
    const y = Number(c.y);
    const width = Number(c.width);
    const height = Number(c.height);
    const inRange = (n: number) => Number.isFinite(n) && n >= 0 && n <= 1;
    if (inRange(x) && inRange(y) && width > 0 && width <= 1 && height > 0 && height <= 1 && x + width <= 1.001 && y + height <= 1.001) {
      cropBox = { x, y, width, height };
    }
  }
  return { rotate, cropBox, verdict, reason };
}

/**
 * Vision judge for `ProductsService.finishImageSanity` — given a downscaled
 * product photo the inline sharp checks flagged, asks gpt-4o-mini for a
 * rotate/crop fix or an "unusable" verdict. Never throws: any failure (no API
 * key, network, malformed JSON) resolves to `null`, and the caller leaves the
 * photo untouched — a sanity pass never makes an upload worse.
 */
@Injectable()
export class ImageSanityVisionClient {
  private readonly log = new Logger(ImageSanityVisionClient.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('OPENAI_API_KEY');
    this.client = key ? new OpenAI({ apiKey: key, timeout: 20_000, maxRetries: 1 }) : null;
    this.model = config.get<string>('OPENAI_IMPORT_MODEL', 'gpt-4o-mini') ?? 'gpt-4o-mini';
  }

  async judge(dataUri: string, reasons: string[]): Promise<ImageSanityVerdict | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          {
            role: 'user',
            content: [
              { type: 'text', text: `Автоматична проверка отбеляза: ${reasons.join(', ')}.` },
              { type: 'image_url', image_url: { url: dataUri } },
            ],
          },
        ],
      });
      return coerceVerdict(res.choices[0]?.message?.content);
    } catch (e) {
      this.log.warn(`vision judge failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }
}
