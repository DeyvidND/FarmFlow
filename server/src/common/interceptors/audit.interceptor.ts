import {
  Injectable,
  Inject,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { type Database, auditLogs } from '@farmflow/db';
import { DB_TOKEN } from '../drizzle/drizzle.constants';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Audit trail: records successful mutating requests made by an authenticated
 * admin (who/what/when) into audit_logs. Public (unauthenticated) requests have
 * no request.user and are skipped. Never breaks the request — insert is
 * fire-and-forget and swallows its own errors.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(@Inject(DB_TOKEN) private readonly db: Database) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest();
    return next.handle().pipe(
      tap(() => {
        const user = req.user;
        if (!user || !MUTATING.has(req.method)) return;
        const res = context.switchToHttp().getResponse();
        void this.db
          .insert(auditLogs)
          .values({
            tenantId: user.tenantId ?? null,
            userId: user.userId ?? null,
            action: req.method,
            path: req.originalUrl ?? req.url,
            statusCode: res.statusCode ?? null,
          })
          .catch(() => undefined);
      }),
    );
  }
}
