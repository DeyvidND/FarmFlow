import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { DigestProcessor } from './digest.processor';
import { DigestService } from './digest.service';
import { getQueueToken } from '@nestjs/bullmq';
import { DIGEST_QUEUE } from '../../common/queue/queue.constants';

function makeQueue() {
  return { add: jest.fn().mockResolvedValue(undefined) };
}

async function build(svc: any, queue: any): Promise<DigestProcessor> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      DigestProcessor,
      { provide: DigestService, useValue: svc },
      { provide: getQueueToken(DIGEST_QUEUE), useValue: queue },
    ],
  }).compile();
  return mod.get(DigestProcessor);
}

describe('DigestProcessor', () => {
  it('"daily" fans out one "tenant" job per eligible tenant', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn().mockResolvedValue(['t1', 't2']), runForTenant: jest.fn() };
    const proc = await build(svc, queue);
    await proc.process({ name: 'daily', data: {} } as Job);
    expect(queue.add).toHaveBeenCalledWith('tenant', { tenantId: 't1' });
    expect(queue.add).toHaveBeenCalledWith('tenant', { tenantId: 't2' });
  });

  it('"tenant" runs the digest for that tenant', async () => {
    const svc = { eligibleTenantIds: jest.fn(), runForTenant: jest.fn().mockResolvedValue(undefined) };
    const proc = await build(svc, makeQueue());
    await proc.process({ name: 'tenant', data: { tenantId: 't9' } } as Job);
    expect(svc.runForTenant).toHaveBeenCalledWith('t9');
  });

  it('onModuleInit registers the 07:00 Europe/Sofia repeatable', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn(), runForTenant: jest.fn() };
    const proc = await build(svc, queue);
    await proc.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'daily',
      {},
      expect.objectContaining({ repeat: { pattern: '0 7 * * *', tz: 'Europe/Sofia' } }),
    );
  });
});
