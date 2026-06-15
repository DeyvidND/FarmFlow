import { Test, TestingModule } from '@nestjs/testing';
import { Job } from 'bullmq';
import { SlotsProcessor } from './slots.processor';
import { SlotsService } from './slots.service';
import { getQueueToken } from '@nestjs/bullmq';
import { SLOTS_QUEUE } from '../../common/queue/queue.constants';

function makeQueue() {
  return { add: jest.fn().mockResolvedValue(undefined) };
}

async function build(svc: any, queue: any): Promise<SlotsProcessor> {
  const mod: TestingModule = await Test.createTestingModule({
    providers: [
      SlotsProcessor,
      { provide: SlotsService, useValue: svc },
      { provide: getQueueToken(SLOTS_QUEUE), useValue: queue },
    ],
  }).compile();
  return mod.get(SlotsProcessor);
}

describe('SlotsProcessor', () => {
  it('"materialize" rolls every active rule forward', async () => {
    const svc = { materializeAllRules: jest.fn().mockResolvedValue(undefined) };
    const proc = await build(svc, makeQueue());
    await proc.process({ name: 'materialize' } as Job);
    expect(svc.materializeAllRules).toHaveBeenCalled();
  });

  it('onModuleInit registers the 06:30 Europe/Sofia repeatable', async () => {
    const queue = makeQueue();
    const proc = await build({ materializeAllRules: jest.fn() }, queue);
    await proc.onModuleInit();
    expect(queue.add).toHaveBeenCalledWith(
      'materialize',
      {},
      expect.objectContaining({ repeat: { pattern: '30 6 * * *', tz: 'Europe/Sofia' } }),
    );
  });
});
