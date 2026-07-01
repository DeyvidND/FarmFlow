import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import { DELIVERY_FAQ, PANEL_FAQ, type FaqEntry, type HelpSurface } from '@fermeribg/help-content';

const MAX_QUESTION = 500;

function corpusFor(surface: HelpSurface): FaqEntry[] {
  return surface === 'delivery' ? DELIVERY_FAQ : PANEL_FAQ;
}

function buildSystemPrompt(entries: FaqEntry[]): string {
  const qa = entries.map((e) => `В: ${e.question}\nО: ${e.answer}`).join('\n\n');
  return (
    'Ти си помощник за българска платформа за фермерски онлайн магазини (ФермериБГ). ' +
    'Отговаряй САМО въз основа на въпросите и отговорите по-долу — това е цялата документация, с която разполагаш. ' +
    'Ако въпросът на потребителя не е покрит в нея, кажи ясно, че не знаеш, и го насочи към списъка с въпроси горе или към поддръжката. ' +
    'Никога не измисляй функционалност, която не е описана тук. Отговаряй кратко и на български.\n\n' +
    qa
  );
}

@Injectable()
export class HelpAiService {
  private readonly log = new Logger(HelpAiService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(config: ConfigService) {
    const key = config.get<string>('OPENAI_API_KEY');
    this.client = key ? new OpenAI({ apiKey: key, timeout: 20_000, maxRetries: 1 }) : null;
    this.model = config.get<string>('OPENAI_IMPORT_MODEL', 'gpt-4o-mini') ?? 'gpt-4o-mini';
  }

  async ask(surface: HelpSurface, question: string): Promise<string> {
    const q = question.trim();
    if (!q) throw new BadRequestException('Въпросът е празен');
    if (q.length > MAX_QUESTION) throw new BadRequestException('Въпросът е твърде дълъг');
    if (!this.client) throw new ServiceUnavailableException('AI помощникът не е достъпен в момента');

    try {
      const res = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: buildSystemPrompt(corpusFor(surface)) },
          { role: 'user', content: q },
        ],
        temperature: 0.2,
      });
      const answer = res.choices[0]?.message?.content?.trim();
      if (!answer) throw new Error('empty response from model');
      return answer;
    } catch (err) {
      this.log.warn(`AI ask failed: ${(err as Error).message}`);
      throw new ServiceUnavailableException('AI помощникът не е достъпен в момента');
    }
  }
}
