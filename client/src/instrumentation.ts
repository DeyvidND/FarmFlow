// Next.js instrumentation hook — loads the right Sentry runtime config and wires
// the request-error capture. register() runs once per server/edge runtime boot;
// onRequestError forwards uncaught errors from React Server Components, route
// handlers, etc. (Next 15+ calls it; harmless export on Next 14.)
import * as Sentry from '@sentry/nextjs';

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('../sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('../sentry.edge.config');
  }
}

export const onRequestError = Sentry.captureRequestError;
