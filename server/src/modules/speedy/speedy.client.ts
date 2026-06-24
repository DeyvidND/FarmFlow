import { Injectable, Logger, BadRequestException } from '@nestjs/common';

export interface SpeedyCreds {
  base: string;
  userName: string;
  password: string;
  clientSystemId?: number;
}

/**
 * Thin HTTP client for the Speedy v1 REST API. Auth is the userName/password
 * (+ optional clientSystemId) merged into every JSON body. `call` throws a clear
 * 400 on any failure (for create/print/track). `callSafe` swallows failures and
 * returns null (for degradable location lookups). `callBinary` returns label bytes.
 */
@Injectable()
export class SpeedyClient {
  private readonly logger = new Logger(SpeedyClient.name);

  private body(creds: SpeedyCreds, body: unknown): string {
    return JSON.stringify({
      userName: creds.userName,
      password: creds.password,
      language: 'BG',
      ...(creds.clientSystemId != null ? { clientSystemId: creds.clientSystemId } : {}),
      ...(body as Record<string, unknown>),
    });
  }

  async call(creds: SpeedyCreds, path: string, body: unknown, timeoutMs = 15000): Promise<any> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${creds.base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.body(creds, body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BadRequestException(`Speedy недостъпен: ${err instanceof Error ? err.message : 'network error'}`);
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON body
    }
    if (!res.ok) {
      const msg = json?.error?.message || json?.message || text?.slice(0, 200) || `HTTP ${res.status}`;
      throw new BadRequestException(`Speedy грешка (${res.status}): ${msg}`);
    }
    // Speedy can return an error envelope with HTTP 200.
    if (json?.error) {
      const msg = json.error?.message || json.error?.id || 'неизвестна грешка';
      throw new BadRequestException(`Speedy грешка: ${msg}`);
    }
    return json;
  }

  /** Degradable variant for location lookups — never throws; returns null on failure. */
  async callSafe(creds: SpeedyCreds, path: string, body: unknown, timeoutMs = 8000): Promise<any | null> {
    try {
      return await this.call(creds, path, body, timeoutMs);
    } catch (err) {
      this.logger.warn(`[speedy] ${path} failed (degraded): ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Fetch a label PDF (raw bytes). Speedy /print returns application/pdf directly,
   *  or an application/json error envelope on failure. */
  async callBinary(creds: SpeedyCreds, path: string, body: unknown, timeoutMs = 15000): Promise<Buffer> {
    let res: Awaited<ReturnType<typeof fetch>>;
    try {
      res = await fetch(`${creds.base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: this.body(creds, body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new BadRequestException(`Speedy недостъпен: ${err instanceof Error ? err.message : 'network error'}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!res.ok || ct.includes('application/json')) {
      const text = await res.text();
      let msg = `HTTP ${res.status}`;
      try {
        const j = JSON.parse(text);
        msg = j?.error?.message || j?.message || msg;
      } catch {
        // ignore
      }
      throw new BadRequestException(`Speedy PDF грешка: ${msg}`);
    }
    return Buffer.from(await res.arrayBuffer());
  }
}
