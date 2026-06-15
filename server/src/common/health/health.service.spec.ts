import { Test, TestingModule } from '@nestjs/testing';
import { HealthService } from './health.service';
import { DB_TOKEN } from '../drizzle/drizzle.constants';
import { REDIS_TOKEN } from '../redis/redis.constants';

function makeDb(execute = jest.fn().mockResolvedValue(undefined)) {
  return { execute } as any;
}
function makeRedis(ping = jest.fn().mockResolvedValue('PONG')) {
  return { ping } as any;
}

async function build(db: any, redis: any): Promise<HealthService> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      HealthService,
      { provide: DB_TOKEN, useValue: db },
      { provide: REDIS_TOKEN, useValue: redis },
    ],
  }).compile();
  return mod.get(HealthService);
}

describe('HealthService', () => {
  it('ready() resolves { status: "ok" } when DB + Redis both respond', async () => {
    const svc = await build(makeDb(), makeRedis());
    await expect(svc.ready()).resolves.toEqual({ status: 'ok' });
  });

  it('ready() rejects when the DB query fails', async () => {
    const db = makeDb(jest.fn().mockRejectedValue(new Error('db down')));
    const svc = await build(db, makeRedis());
    await expect(svc.ready()).rejects.toThrow('db down');
  });

  it('ready() rejects when Redis ping fails', async () => {
    const redis = makeRedis(jest.fn().mockRejectedValue(new Error('redis down')));
    const svc = await build(makeDb(), redis);
    await expect(svc.ready()).rejects.toThrow('redis down');
  });
});
