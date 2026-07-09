import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
  Injectable,
  Inject,
} from '@nestjs/common';
import { Response } from 'express';
import * as Sentry from '@sentry/nestjs';
import { type Database, errorEvents } from '@fermeribg/db';
import { DB_TOKEN } from '../drizzle/drizzle.constants';

// Caps mirror the errorEvents schema comment (packages/db/src/schema.ts) — keep an
// oversized Error.message/stack from bloating a row indefinitely.
const MESSAGE_CAP = 1000;
const STACK_CAP = 4000;

@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  // Registered as APP_FILTER (see app.module.ts / econt-app.module.ts) — a real
  // Nest provider, not `new GlobalExceptionFilter()` — so constructor DI resolves
  // normally. DrizzleModule is @Global(), so DB_TOKEN is available in both the
  // main API and the standalone Econt-app process without extra wiring.
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<any>();

    let status = 500;
    let message: unknown = 'Internal server error';

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      message = exception.getResponse();
    } else if (exception instanceof Error) {
      // Raw Error.message from lower layers (pg/Drizzle, fetch, AWS SDK) can leak
      // schema/constraint/infra details. Log it server-side; return a generic
      // message to clients in production.
      this.logger.error(exception.stack ?? exception.message);
      message =
        process.env.NODE_ENV === 'production' ? 'Internal server error' : exception.message;
    }

    // Report only true server-side failures (5xx) to Sentry. 4xx are client
    // errors (validation / auth / not-found) — capturing them would be noise and
    // burn the free-tier quota. No-op when Sentry isn't initialized (no DSN).
    if (status >= 500) {
      Sentry.captureException(exception);
      this.recordErrorEvent(exception, status, request);
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Fire-and-forget: powers the super-admin cross-tenant "Проблеми" feed
   * (GET /platform/problems). Never awaited by `catch()` and never allowed to
   * throw — a DB hiccup here must not affect the error response already sent.
   */
  private recordErrorEvent(exception: unknown, status: number, req: any): void {
    const rawMessage =
      exception instanceof Error ? exception.message : typeof exception === 'string' ? exception : String(exception);
    const rawStack = exception instanceof Error ? (exception.stack ?? null) : null;
    const user = req?.user;

    void this.db
      .insert(errorEvents)
      .values({
        method: req?.method ?? 'UNKNOWN',
        path: req?.originalUrl ?? req?.url ?? 'unknown',
        statusCode: status,
        message: rawMessage ? rawMessage.slice(0, MESSAGE_CAP) : null,
        stack: rawStack ? rawStack.slice(0, STACK_CAP) : null,
        tenantId: user?.tenantId ?? null,
        userId: user?.userId ?? null,
        adminId: user?.adminId ?? user?.actingAdminId ?? null,
      })
      .catch(() => undefined);
  }
}
