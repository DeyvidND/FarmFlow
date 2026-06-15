import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { BillingProcessor } from './billing.processor';
import { BillingService } from './billing.service';
import { getQueueToken } from '@nestjs/bullmq';
import { BILLING_QUEUE } from '../../common/queue/queue.constants';

function makeQueue() {
  return { add: jest.fn().mockResolvedValue(undefined) };
}

async function build(svc: any, queue: any): Promise<BillingProcessor> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      BillingProcessor,
      { provide: BillingService, useValue: svc },
      { provide: getQueueToken(BILLING_QUEUE), useValue: queue },
    ],
  }).compile();
  return mod.get(BillingProcessor);
}

describe('BillingProcessor', () => {
  it('"suspend-grace" suspends farms past their grace window', async () => {
    const svc = { suspendExpiredGrace: jest.fn().mockResolvedValue(undefined) };
    const proc = await build(svc, makeQueue());
    await proc.process({ name: 'suspend-grace' } as Job);
    expect(svc.suspendExpiredGrace).toHaveBeenCalled();
  });

  it('onModuleInit registers the 03:00 Europe/Sofia repeatable', async () => {
    const queue = makeQueue();
    const proc = await build({ suspendExpiredGrace: jest.fn() }, queue);
    await proc.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'suspend-grace',
      {},
      expect.objectContaining({ repeat: { pattern: '0 3 * * *', tz: 'Europe/Sofia' } }),
    );
  });
});
