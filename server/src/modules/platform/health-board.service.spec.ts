import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { HealthBoardService } from './health-board.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';
import { REDIS_TOKEN } from '../../common/redis/redis.constants';
import {
  EMAIL_QUEUE,
  OPERATOR_DIGEST_QUEUE,
  ECONT_QUEUE,
  SPEEDY_QUEUE,
  NEWSLETTER_DRAFT_QUEUE,
  IMAGE_QUEUE,
  BILLING_QUEUE,
  ANALYTICS_QUEUE,
  CLEANUP_QUEUE,
} from '../../common/queue/queue.constants';

const ALL_QUEUES = [
  EMAIL_QUEUE,
  OPERATOR_DIGEST_QUEUE,
  ECONT_QUEUE,
  SPEEDY_QUEUE,
  NEWSLETTER_DRAFT_QUEUE,
  IMAGE_QUEUE,
  BILLING_QUEUE,
  ANALYTICS_QUEUE,
  CLEANUP_QUEUE,
];

/** A drizzle query-builder stub: every chain method returns itself, and it
 *  resolves to `rows` however deep the caller awaits it — mirrors real
 *  drizzle builders (thenable + chainable), so it doesn't matter whether the
 *  code awaits after `.where()` or after a trailing `.limit()`. */
function chainable(rows: unknown) {
  const obj: Record<string, unknown> = {};
  for (const m of ['select', 'from', 'leftJoin', 'where', 'groupBy', 'having', 'orderBy', 'limit']) {
    obj[m] = jest.fn(() => obj);
  }
  obj.then = (resolve: (v: unknown) => void) => resolve(rows);
  return obj;
}

function makeQueue(overrides: { counts?: Record<string, number>; jobs?: { finishedOn?: number; timestamp?: number }[]; failing?: boolean } = {}) {
  if (overrides.failing) {
    return {
      getJobCounts: jest.fn().mockRejectedValue(new Error('redis down')),
      getJobs: jest.fn().mockRejectedValue(new Error('redis down')),
    };
  }
  return {
    getJobCounts: jest.fn().mockResolvedValue(overrides.counts ?? { waiting: 0, active: 0, delayed: 0 }),
    getJobs: jest.fn().mockResolvedValue((overrides.jobs ?? []).map((j) => ({ finishedOn: j.finishedOn, timestamp: j.timestamp }))),
  };
}

describe('HealthBoardService', () => {
  let db: { execute: jest.Mock; select: jest.Mock };
  let redis: { ping: jest.Mock };

  async function build(queueOverrides: Record<string, ReturnType<typeof makeQueue>> = {}) {
    const providers = [
      HealthBoardService,
      { provide: DB_TOKEN, useValue: db },
      { provide: REDIS_TOKEN, useValue: redis },
      ...ALL_QUEUES.map((name) => ({
        provide: getQueueToken(name),
        useValue: queueOverrides[name] ?? makeQueue(),
      })),
    ];
    const module: TestingModule = await Test.createTestingModule({ providers }).compile();
    return module.get(HealthBoardService);
  }

  beforeEach(() => {
    db = { execute: jest.fn().mockResolvedValue(undefined), select: jest.fn() };
    redis = { ping: jest.fn().mockResolvedValue('PONG') };
    // Default: all 4 errorStats queries return empty.
    db.select
      .mockImplementationOnce(() => chainable([]))
      .mockImplementationOnce(() => chainable([]))
      .mockImplementationOnce(() => chainable([]))
      .mockImplementationOnce(() => chainable([]));
  });

  describe('services', () => {
    it('reports db/redis up when both probes succeed', async () => {
      const service = await build();
      const { services } = await service.healthBoard();
      expect(services).toEqual({ db: 'up', redis: 'up' });
    });

    it('reports db down without throwing when the probe rejects', async () => {
      db.execute.mockRejectedValueOnce(new Error('connection refused'));
      const service = await build();
      const { services } = await service.healthBoard();
      expect(services.db).toBe('down');
    });

    it('reports redis down without throwing when ping rejects', async () => {
      redis.ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      const service = await build();
      const { services } = await service.healthBoard();
      expect(services.redis).toBe('down');
    });
  });

  describe('queues', () => {
    it('flags a queue ok when depth is under threshold and nothing recently failed', async () => {
      const service = await build({ [EMAIL_QUEUE]: makeQueue({ counts: { waiting: 5, active: 1, delayed: 0 } }) });
      const { queues } = await service.healthBoard();
      const email = queues.find((q) => q.name === EMAIL_QUEUE);
      expect(email).toMatchObject({ status: 'ok', waiting: 5, failed: 0 });
    });

    it('flags a queue as backlog when waiting+delayed exceeds the threshold', async () => {
      const service = await build({ [EMAIL_QUEUE]: makeQueue({ counts: { waiting: 80, active: 0, delayed: 30 } }) });
      const { queues } = await service.healthBoard();
      const email = queues.find((q) => q.name === EMAIL_QUEUE);
      expect(email?.status).toBe('backlog');
    });

    it('flags a queue as backlog when a job failed inside the 24h window', async () => {
      const recentlyFailed = makeQueue({ jobs: [{ finishedOn: Date.now() - 60_000 }] });
      const service = await build({ [BILLING_QUEUE]: recentlyFailed });
      const { queues } = await service.healthBoard();
      const billing = queues.find((q) => q.name === BILLING_QUEUE);
      expect(billing).toMatchObject({ status: 'backlog', failed: 1 });
    });

    it('does not count a failed job from outside the 24h window', async () => {
      const oldFailure = makeQueue({ jobs: [{ finishedOn: Date.now() - 30 * 86_400_000 }] });
      const service = await build({ [BILLING_QUEUE]: oldFailure });
      const { queues } = await service.healthBoard();
      const billing = queues.find((q) => q.name === BILLING_QUEUE);
      expect(billing).toMatchObject({ status: 'ok', failed: 0 });
    });

    it('degrades a single dead queue to status:error + a note, without failing the board', async () => {
      const service = await build({ [SPEEDY_QUEUE]: makeQueue({ failing: true }) });
      const { queues, notes } = await service.healthBoard();
      const speedy = queues.find((q) => q.name === SPEEDY_QUEUE);
      expect(speedy).toMatchObject({ status: 'error', waiting: 0, failed: 0 });
      expect(notes?.some((n) => n.includes(SPEEDY_QUEUE))).toBe(true);
    });
  });

  describe('errors', () => {
    it('maps the 4 parallel queries into last24h/topPaths/topTenants/recent', async () => {
      db.select = jest
        .fn()
        .mockImplementationOnce(() => chainable([{ count: 12 }]))
        .mockImplementationOnce(() => chainable([{ path: '/orders', count: 9 }]))
        .mockImplementationOnce(() => chainable([{ tenantId: 't1', tenantName: 'Чайка', count: 9 }]))
        .mockImplementationOnce(() =>
          chainable([
            {
              method: 'GET',
              path: '/orders',
              statusCode: 500,
              message: 'boom',
              tenantId: 't1',
              tenantName: 'Чайка',
              createdAt: new Date('2026-07-12T10:00:00Z'),
              resolvedAt: null,
            },
          ]),
        );
      const service = await build();

      const { errors } = await service.healthBoard();

      expect(errors.last24h).toBe(12);
      expect(errors.topPaths).toEqual([{ path: '/orders', count: 9 }]);
      expect(errors.topTenants).toEqual([{ tenantId: 't1', tenantName: 'Чайка', count: 9 }]);
      expect(errors.recent).toEqual([
        {
          method: 'GET',
          path: '/orders',
          statusCode: 500,
          message: 'boom',
          tenantId: 't1',
          tenantName: 'Чайка',
          createdAt: '2026-07-12T10:00:00.000Z',
          resolved: false,
        },
      ]);
    });

    it('marks a recent error resolved only when it is at/before the resolution time', async () => {
      db.select = jest
        .fn()
        .mockImplementationOnce(() => chainable([{ count: 1 }]))
        .mockImplementationOnce(() => chainable([]))
        .mockImplementationOnce(() => chainable([]))
        .mockImplementationOnce(() =>
          chainable([
            {
              method: 'GET',
              path: '/orders',
              statusCode: 500,
              message: 'old, already fixed',
              tenantId: 't1',
              tenantName: 'Чайка',
              createdAt: new Date('2026-07-10T10:00:00Z'),
              resolvedAt: new Date('2026-07-11T00:00:00Z'),
            },
          ]),
        );
      const service = await build();

      const { errors } = await service.healthBoard();

      expect(errors.recent[0].resolved).toBe(true);
    });

    it('degrades to zeros with a note when the error_events query throws', async () => {
      db.select = jest.fn().mockImplementationOnce(() => {
        throw new Error('relation "error_events" does not exist');
      });
      const service = await build();

      const { errors, notes } = await service.healthBoard();

      expect(errors).toEqual({ last24h: 0, topPaths: [], topTenants: [], recent: [] });
      expect(notes?.some((n) => n.includes('error_events'))).toBe(true);
    });
  });

  describe('healthBoard() shape', () => {
    it('always notes that digest/slots/products queues are not wired', async () => {
      const service = await build();
      const { notes } = await service.healthBoard();
      expect(notes?.some((n) => n.includes('digest') && n.includes('slots') && n.includes('products'))).toBe(true);
    });

    it('returns all 9 wired queues', async () => {
      const service = await build();
      const { queues } = await service.healthBoard();
      expect(queues.map((q) => q.name).sort()).toEqual([...ALL_QUEUES].sort());
    });
  });
});
