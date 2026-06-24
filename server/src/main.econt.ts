import './instrument';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import { EcontAppModule } from './modules/econt-app/econt-app.module';

async function bootstrap() {
  const app = await NestFactory.create(EcontAppModule);
  app.enableShutdownHooks();

  const config = app.get(ConfigService);
  const corsOrigins = config
    .get<string>('CORS_ORIGIN_ECONT', 'http://localhost:3200')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  const port = config.get<number>('PORT_ECONT', 3100);

  app.getHttpAdapter().getInstance().set('trust proxy', config.get<string>('TRUST_PROXY') ?? false);
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' }, crossOriginEmbedderPolicy: false }));
  app.use(compression());

  app.use((req: any, res: any, next: () => void) => {
    const origin = req.headers.origin;
    res.header('Vary', 'Origin');
    if (origin && corsOrigins.includes(origin)) {
      res.header('Access-Control-Allow-Origin', origin);
      res.header('Access-Control-Allow-Credentials', 'true');
    }
    res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }));

  await app.listen(port);
  console.log(`Econt standalone API running on http://localhost:${port}`);
}

bootstrap();
