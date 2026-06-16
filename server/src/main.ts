import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { text } from 'express';
import helmet from 'helmet';
import compression from 'compression';
import { runMigrations, ensureSuperAdmin } from '@farmflow/db';
import { AppModule } from './app.module';

/**
 * Parse the `TRUST_PROXY` env into an Express `trust proxy` setting. This decides
 * which IP the rate limiter keys on, so getting it right matters:
 *   - unset / "false" → trust nobody; `req.ip` is the socket peer (correct for
 *     direct exposure; the SAFE default — X-Forwarded-For can't be spoofed to
 *     rotate IPs and evade limits).
 *   - a number (e.g. "1") → trust exactly N proxy hops in front (set this to the
 *     real hop count when behind nginx/Cloudflare so `req.ip` is the client, not
 *     the proxy — otherwise every client shares one bucket).
 *   - "true" → trust all proxies (only if the edge strips inbound XFF).
 *   - any other string → passed through (e.g. "loopback", a CIDR list).
 */
function parseTrustProxy(value?: string): boolean | number | string {
  if (!value || value === 'false') return false;
  if (value === 'true') return true;
  const n = Number(value);
  return Number.isInteger(n) ? n : value;
}

async function bootstrap() {
  // Apply any pending DB migrations on boot so every deploy self-heals the schema
  // with no manual step (the whole pipeline is github → dokploy). Idempotent;
  // throws (and aborts startup) if the DB is unreachable or a migration fails.
  await runMigrations();

  // Seed the first platform super-admin from env if the DB has none yet (no-op
  // otherwise). Lets a fresh deploy bootstrap a login with no manual step; the
  // super-admin then onboards farms via the admin panel.
  await ensureSuperAdmin();

  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Wire SIGTERM/SIGINT to Nest's lifecycle so OnModuleDestroy hooks run: BullMQ
  // workers finish in-flight jobs, the pg pool and Redis client close cleanly.
  // Required for zero-drop rolling deploys. The orchestrator (Dokploy) must allow
  // a termination grace period long enough for in-flight work to drain.
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  // Comma-separated allowlist so the dashboard, admin panel, and any other
  // first-party origin can each call the API with credentials.
  const corsOrigins = config
    .get<string>('CORS_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const port = config.get<number>('PORT', 3000);

  // Correct client-IP attribution for the rate limiter behind a proxy/CDN.
  app.getHttpAdapter().getInstance().set('trust proxy', parseTrustProxy(config.get<string>('TRUST_PROXY')));

  // Security headers. CSP is disabled (this is a JSON API + serves the Swagger UI;
  // CSP belongs on the storefronts). CORP is relaxed to cross-origin so browsers on
  // other origins can read the world-readable `/public/*` catalog.
  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Gzip/brotli response bodies. In production the API sits behind a Cloudflare
  // Tunnel on a home-server uplink; cloudflared does NOT compress the origin→edge
  // leg, so without this every catalog/bootstrap/article JSON crosses the tunnel
  // raw. Cuts JSON payloads ~80-90%. Express's weak ETag still works (computed on
  // the compressed representation), so conditional 304s are unaffected.
  app.use(compression());

  // Capture the bounce/complaint webhook body as a raw string regardless of
  // content-type. The raw string is needed to verify Resend's Svix signature
  // (computed over the exact body) before we JSON.parse it.
  app.use('/email/webhook', text({ type: () => true }));

  // Path-aware CORS: `/public/*` storefront endpoints are world-readable (any
  // origin, no credentials); every other (admin) route is locked to the panel
  // origin. Admin auth is Bearer-based, so CORS is defense-in-depth there.
  app.use((req: any, res: any, next: () => void) => {
    const origin = req.headers.origin;
    const isPublic = req.path.startsWith('/public/');
    // The storefront inline-edit overlay (`/tenants/me/site-edit/*`) is called
    // from arbitrary client-factory storefront origins and is authorized by a
    // short-lived Bearer edit-token (NOT cookies) — so the origin isn't the
    // security boundary and locking it to the CORS_ORIGIN allowlist would have to
    // be maintained per storefront. Treat it like `/public/*`: any origin, no
    // credentials. The EditSessionGuard (valid token required) is the real gate.
    const isTokenEdit = req.path.startsWith('/tenants/me/site-edit/');
    // The ACAO value varies by request Origin on every branch (wildcard vs the
    // reflected allowlisted origin vs nothing), so always advertise that to shared
    // caches — otherwise a CDN could serve one origin's response to another.
    res.header('Vary', 'Origin');
    if (isPublic || isTokenEdit) {
      res.header('Access-Control-Allow-Origin', '*');
    } else if (origin && corsOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');

    // Edge/CDN caching for the world-readable storefront catalog. `max-age=0`
    // keeps browsers revalidating (cheap 304 via Express's ETag) while a shared
    // cache serves `s-maxage` seconds and refreshes in the background within the
    // `stale-while-revalidate` window. Slots carry live remaining-capacity, so
    // they get a short window; all other public reads can sit longer. Public
    // writes (checkout/orders/reviews) must never be cached.
    if (isPublic) {
      if (req.method === 'GET') {
        const isSlots = req.path.endsWith('/slots');
        // A single order summary (/public/:slug/orders/:id) is per-customer PII +
        // live payment status — must never sit in a shared cache, even though it's
        // a public (token-less) GET. Carve it out the same way slots are.
        const isOrderSummary = /\/orders\/[^/]+$/.test(req.path);
        res.header(
          'Cache-Control',
          isOrderSummary
            ? 'no-store'
            : isSlots
              ? 'public, max-age=0, s-maxage=10, stale-while-revalidate=30'
              : 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
        );
      } else {
        res.header('Cache-Control', 'no-store');
      }
    }

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // Swagger only outside production — don't expose the API surface publicly.
  const swaggerEnabled = process.env.NODE_ENV !== 'production';
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('FarmFlow API')
      .setDescription('FarmFlow backend API')
      .setVersion('0.1')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('docs', app, document);
  }

  await app.listen(port);
  console.log(`FarmFlow API running on http://localhost:${port}`);
  if (swaggerEnabled) console.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
