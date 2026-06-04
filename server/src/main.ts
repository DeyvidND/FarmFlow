import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { rawBody: true });

  const config = app.get(ConfigService);
  const corsOrigin = config.get<string>('CORS_ORIGIN', 'http://localhost:3000');
  const port = config.get<number>('PORT', 3000);

  // Path-aware CORS: `/public/*` storefront endpoints are world-readable (any
  // origin, no credentials); every other (admin) route is locked to the panel
  // origin. Admin auth is Bearer-based, so CORS is defense-in-depth there.
  app.use((req: any, res: any, next: () => void) => {
    const origin = req.headers.origin;
    const isPublic = req.path.startsWith('/public/');
    if (isPublic) {
      res.header('Access-Control-Allow-Origin', '*');
    } else if (origin && origin === corsOrigin) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Vary', 'Origin');
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
        res.header(
          'Cache-Control',
          isSlots
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

  const swaggerConfig = new DocumentBuilder()
    .setTitle('FarmFlow API')
    .setDescription('FarmFlow backend API')
    .setVersion('0.1')
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  await app.listen(port);
  console.log(`FarmFlow API running on http://localhost:${port}`);
  console.log(`Swagger docs at http://localhost:${port}/docs`);
}

bootstrap();
