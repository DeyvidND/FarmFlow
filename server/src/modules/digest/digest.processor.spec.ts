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
    expect(queue.add).toHaveBeenCalledWith(
      'tenant',
      { tenantId: 't1' },
      expect.objectContaining({ jobId: expect.stringMatching(/^digest-tenant-t1-\d{8}$/) }),
    );
    expect(queue.add).toHaveBeenCalledWith(
      'tenant',
      { tenantId: 't2' },
      expect.objectContaining({ jobId: expect.stringMatching(/^digest-tenant-t2-\d{8}$/) }),
    );
  });

  it('"daily" fan-out uses the SAME jobId on a re-fan (dedup on parent retry)', async () => {
    const queue = makeQueue();
    const svc = { eligibleTenantIds: jest.fn().mockResolvedValue(['t1']), runForTenant: jest.fn() };
    const proc = await build(svc, queue);
    await proc.process({ name: 'daily', data: {} } as Job);
    await proc.process({ name: 'daily', data: {} } as Job);
    const jobIds = queue.add.mock.calls
      .filter((call: unknown[]) => call[0] === 'tenant')
      .map((call: unknown[]) => (call[2] as { jobId: string }).jobId);
    expect(jobIds).toHaveLength(2);
    expect(jobIds[0]).toEqual(jobIds[1]);
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

  describe('Task #14 — tomorrow-email fan-out', () => {
    it('onModuleInit also registers the 18:00 Europe/Sofia "tomorrow" repeatable', async () => {
      const queue = makeQueue();
      const svc = { eligibleTenantIds: jest.fn(), runForTenant: jest.fn() };
      const proc = await build(svc, queue);
      await proc.onModuleInit();
      expect(queue.add).toHaveBeenCalledWith(
        'tomorrow',
        {},
        expect.objectContaining({ repeat: { pattern: '0 18 * * *', tz: 'Europe/Sofia' } }),
      );
    });

    it('"tomorrow" fans out one "tenant-tomorrow" job per EVERY tenant (not just eligible ones)', async () => {
      const queue = makeQueue();
      const svc = { allTenantIds: jest.fn().mockResolvedValue(['t1', 't2', 't3']), runTomorrowForTenant: jest.fn() };
      const proc = await build(svc, queue);
      await proc.process({ name: 'tomorrow', data: {} } as Job);
      expect(queue.add).toHaveBeenCalledWith(
        'tenant-tomorrow',
        { tenantId: 't1' },
        expect.objectContaining({ jobId: expect.stringMatching(/^digest-tomorrow-t1-\d{8}$/) }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'tenant-tomorrow',
        { tenantId: 't2' },
        expect.objectContaining({ jobId: expect.stringMatching(/^digest-tomorrow-t2-\d{8}$/) }),
      );
      expect(queue.add).toHaveBeenCalledWith(
        'tenant-tomorrow',
        { tenantId: 't3' },
        expect.objectContaining({ jobId: expect.stringMatching(/^digest-tomorrow-t3-\d{8}$/) }),
      );
    });

    it('"tomorrow" fan-out uses the SAME jobId on a re-fan (dedup on parent retry)', async () => {
      const queue = makeQueue();
      const svc = { allTenantIds: jest.fn().mockResolvedValue(['t1']), runTomorrowForTenant: jest.fn() };
      const proc = await build(svc, queue);
      await proc.process({ name: 'tomorrow', data: {} } as Job);
      await proc.process({ name: 'tomorrow', data: {} } as Job);
      const jobIds = queue.add.mock.calls
        .filter((call: unknown[]) => call[0] === 'tenant-tomorrow')
        .map((call: unknown[]) => (call[2] as { jobId: string }).jobId);
      expect(jobIds).toHaveLength(2);
      expect(jobIds[0]).toEqual(jobIds[1]);
    });

    it('"tenant-tomorrow" runs the tomorrow-email job for that tenant', async () => {
      const svc = { allTenantIds: jest.fn(), runTomorrowForTenant: jest.fn().mockResolvedValue(undefined) };
      const proc = await build(svc, makeQueue());
      await proc.process({ name: 'tenant-tomorrow', data: { tenantId: 't9' } } as Job);
      expect(svc.runTomorrowForTenant).toHaveBeenCalledWith('t9');
    });
  });
});
