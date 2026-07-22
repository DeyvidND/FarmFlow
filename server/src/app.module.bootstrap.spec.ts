import * as fs from 'fs';
import * as path from 'path';

// Load server/.env into process.env BEFORE importing AppModule, so every
// ConfigService.getOrThrow (JWT_SECRET, …) and the DrizzleModule/BullMQ
// connection factories have what they need to instantiate. Mirrors the real
// process boot; only fills vars that aren't already set.
const envPath = path.resolve(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
  }
}

// eslint-disable-next-line import/first
import { Test } from '@nestjs/testing';
// eslint-disable-next-line import/first
import { AppModule } from './app.module';

/**
 * Bootstrap guard. NOTHING else in the suite instantiates the whole AppModule
 * DI graph, so a circular-module-import that leaves an `imports:[]` entry
 * `undefined` at decoration time (Nest: "cannot create X — the module at index
 * [n] is undefined") sails through every green unit test and only explodes at
 * real app boot — i.e. in production. This compiles the full graph, which is
 * exactly what that failure blocks, so it goes red the moment such a cycle is
 * introduced. It needs the dev Postgres+Redis (docker compose) up, same as the
 * other integration-touching specs.
 */
describe('AppModule bootstrap (full DI graph resolves)', () => {
  it('compiles the entire module graph — guards against circular-dependency `undefined` at boot', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    expect(moduleRef).toBeDefined();
    await moduleRef.close();
  }, 150000);
});
