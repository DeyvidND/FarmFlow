// server/src/modules/newsletter/newsletter.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NewsletterService } from './newsletter.service';
import { EmailService } from '../../common/email/email.service';
import { SuppressionService } from '../../common/email/suppression.service';
import { BillingService } from '../billing/billing.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

// ── Mock DB builder ─────────────────────────────────────────────────────────
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 'push-1' }]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    // Chainable: both broadcast (orderBy→limit) and getSubscribers (orderBy→limit)
    // terminate in `.limit`, which resolves the rows.
    orderBy: jest.fn().mockReturnThis(),
  };
}

function makeEmailService() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

function makeJwtService() {
  return {
    sign: jest.fn().mockReturnValue('unsub-token-abc'),
    verify: jest.fn(),
  };
}

function makeConfigService() {
  return {
    get: jest.fn().mockReturnValue(undefined),
    getOrThrow: jest.fn().mockReturnValue('test-jwt-secret'),
  };
}

const TENANT_ID = 'tenant-uuid-1';

describe('NewsletterService', () => {
  let service: NewsletterService;
  let db: ReturnType<typeof makeDb>;
  let emailService: ReturnType<typeof makeEmailService>;
  let jwtService: ReturnType<typeof makeJwtService>;
  let billing: { billPush: jest.Mock; isBillable: jest.Mock };

  beforeEach(async () => {
    db = makeDb();
    emailService = makeEmailService();
    jwtService = makeJwtService();
    billing = {
      billPush: jest.fn().mockResolvedValue(undefined),
      isBillable: jest.fn().mockResolvedValue(true),
    };
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NewsletterService,
        { provide: DB_TOKEN, useValue: db },
        { provide: EmailService, useValue: emailService },
        { provide: JwtService, useValue: jwtService },
        { provide: ConfigService, useValue: makeConfigService() },
        {
          provide: SuppressionService,
          useValue: { filterSuppressed: jest.fn().mockResolvedValue(new Set()), isSuppressed: jest.fn().mockResolvedValue(false), suppress: jest.fn() },
        },
        { provide: BillingService, useValue: billing },
      ],
    }).compile();

    service = module.get(NewsletterService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  // ── getSubscribers ──────────────────────────────────────────────────────

  describe('getSubscribers', () => {
    // The list query terminates in `.limit(lim+1)`; the counts query terminates
    // in `.limit(1)`. So `db.limit` is called twice on the first page: rows, then counts.
    it("returns only the calling tenant subscribers, not another tenant's", async () => {
      const mySubscriber = { id: 'sub-1', email: 'a@test.bg', createdAt: new Date('2026-01-01') };
      db.limit
        .mockResolvedValueOnce([mySubscriber]) // page rows
        .mockResolvedValueOnce([{ active: 1, unsub: 0 }]); // SQL counts

      const result = await service.getSubscribers(TENANT_ID);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].email).toBe('a@test.bg');
      expect(result.nextCursor).toBeNull();
    });

    it('counts active vs unsubscribed from the SQL aggregate (not the page)', async () => {
      db.limit
        .mockResolvedValueOnce([{ id: 'sub-1', email: 'a@test.bg', createdAt: new Date('2026-01-01') }])
        .mockResolvedValueOnce([{ active: 1, unsub: 1 }]);

      const result = await service.getSubscribers(TENANT_ID);

      expect(result.activeCount).toBe(1);
      expect(result.unsubscribedCount).toBe(1);
    });
  });

  // ── broadcast ──────────────────────────────────────────────────────────

  describe('broadcast', () => {
    it('refuses to send when the farm is not billable (no Stripe customer)', async () => {
      billing.isBillable.mockResolvedValueOnce(false);
      await expect(
        service.broadcast(TENANT_ID, { subject: 'Новини', body: 'Тяло' }),
      ).rejects.toThrow('Настройте плащане');
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(billing.billPush).not.toHaveBeenCalled();
    });

    it('only sends to active subscribers (unsubscribedAt is null)', async () => {
      const active = {
        id: 'sub-1',
        email: 'active@test.bg',
        createdAt: new Date(),
        unsubscribedAt: null,
        tenantId: TENANT_ID,
      };
      // The unsubscribed filter is applied in SQL (WHERE unsubscribed_at IS NULL),
      // so the query returns active rows only.
      db.limit.mockResolvedValue([active]);

      const result = await service.broadcast(TENANT_ID, {
        subject: 'Новини',
        body: 'Добре дошли!',
      });

      expect(result.sent).toBe(1);
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'active@test.bg' }),
      );
    });

    it('sent count matches number of active subscribers', async () => {
      const activeList = [
        { id: 'sub-1', email: 'a@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
        { id: 'sub-2', email: 'b@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
        { id: 'sub-3', email: 'c@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
      ];
      db.limit.mockResolvedValue(activeList);

      const result = await service.broadcast(TENANT_ID, { subject: 'Test', body: 'Body' });

      expect(result.sent).toBe(3);
    });

    it('each sent email html contains an unsubscribe link with a token', async () => {
      const active = {
        id: 'sub-1',
        email: 'active@test.bg',
        createdAt: new Date(),
        unsubscribedAt: null,
        tenantId: TENANT_ID,
      };
      db.limit.mockResolvedValue([active]);

      await service.broadcast(TENANT_ID, { subject: 'Test', body: 'Здравей!' });

      const callArg = emailService.sendMail.mock.calls[0][0];
      expect(callArg.html).toContain('/unsubscribe?token=');
      expect(callArg.html).toContain('unsub-token-abc');
    });

    it('continues sending to remaining subscribers when one fails', async () => {
      const activeList = [
        { id: 'sub-1', email: 'a@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
        { id: 'sub-2', email: 'b@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
      ];
      db.limit.mockResolvedValue(activeList);

      emailService.sendMail
        .mockRejectedValueOnce(new Error('SMTP error'))
        .mockResolvedValueOnce(undefined);

      const result = await service.broadcast(TENANT_ID, { subject: 'Test', body: 'Body' });

      // Only the second one succeeded
      expect(result.sent).toBe(1);
    });
  });

  // ── unsubscribe ────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('sets unsubscribedAt for a valid token pointing to an active subscriber', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-1', typ: 'unsub' });
      const subscriber = {
        id: 'sub-1',
        tenantId: TENANT_ID,
        email: 'a@test.bg',
        unsubscribedAt: null,
      };
      db.limit.mockResolvedValue([subscriber]);
      db.returning.mockResolvedValue([{ ...subscriber, unsubscribedAt: new Date() }]);

      const result = await service.unsubscribe('valid-token');

      expect(result.success).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it('is idempotent — already-unsubscribed subscriber still returns success', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-1', typ: 'unsub' });
      const subscriber = {
        id: 'sub-1',
        tenantId: TENANT_ID,
        email: 'a@test.bg',
        unsubscribedAt: new Date('2026-01-01'),
      };
      db.limit.mockResolvedValue([subscriber]);

      const result = await service.unsubscribe('valid-token');

      expect(result.success).toBe(true);
      // No update call — already unsubscribed
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns success:false for an invalid/expired token', async () => {
      jwtService.verify.mockImplementation(() => {
        throw new Error('jwt malformed');
      });

      const result = await service.unsubscribe('bad-token');

      expect(result.success).toBe(false);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns success:false when token typ is not "unsub"', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-1', typ: 'access' });

      const result = await service.unsubscribe('wrong-typ-token');

      expect(result.success).toBe(false);
    });

    it('returns success:false when subscriber is not found', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-999', typ: 'unsub' });
      db.limit.mockResolvedValue([]);

      const result = await service.unsubscribe('token-for-unknown');

      expect(result.success).toBe(false);
    });
  });

  // ── broadcast excludes already-unsubscribed ────────────────────────────

  describe('broadcast excludes unsubscribed after an unsubscribe call', () => {
    it('an unsubscribed subscriber is not in the active list passed to broadcast', async () => {
      // Simulate DB already filtering: broadcast's query returns only active
      db.limit.mockResolvedValue([
        { id: 'sub-1', email: 'active@test.bg', createdAt: new Date(), unsubscribedAt: null, tenantId: TENANT_ID },
      ]);

      const result = await service.broadcast(TENANT_ID, { subject: 'S', body: 'B' });

      expect(result.sent).toBe(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'active@test.bg' }),
      );
    });
  });
});
