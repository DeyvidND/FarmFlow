import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import * as Sentry from '@sentry/nestjs';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

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
    }

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
