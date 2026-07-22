// server/src/modules/newsletter/newsletter.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { NewsletterService } from './newsletter.service';
import { EmailService } from '../../common/email/email.service';
import { SuppressionService } from '../../common/email/suppression.service';
import { BillingService } from '../billing/billing.service';
import { StorageService } from '../storage/storage.service';
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
    delete: jest.fn().mockReturnThis(),
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
    get: jest.fn().mockReturnValue(undefined), // → service falls back to defaults (555, 5000)
    getOrThrow: jest.fn().mockReturnValue('test-jwt-secret'),
  };
}

function makeStorage() {
  return {
    upload: jest.fn().mockResolvedValue({ key: 'k', url: 'https://cdn.x/k.jpg' }),
    delete: jest.fn().mockResolvedValue(undefined),
    deleteByPrefix: jest.fn().mockResolvedValue(undefined),
    getPublicUrl: jest.fn(),
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
        { provide: StorageService, useValue: makeStorage() },
      ],
    }).compile();

    service = module.get(NewsletterService);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  // ── getSubscribers ──────────────────────────────────────────────────────

  describe('getSubscribers', () => {
    it("returns only the calling tenant subscribers", async () => {
      db.limit
        .mockResolvedValueOnce([{ id: 'sub-1', email: 'a@test.bg', createdAt: new Date('2026-01-01') }])
        .mockResolvedValueOnce([{ active: 1, unsub: 0 }]);

      const result = await service.getSubscribers(TENANT_ID);

      expect(result.items).toHaveLength(1);
      expect(result.items[0].email).toBe('a@test.bg');
      expect(result.nextCursor).toBeNull();
    });

    it('counts active vs unsubscribed from the SQL aggregate', async () => {
      db.limit
        .mockResolvedValueOnce([{ id: 'sub-1', email: 'a@test.bg', createdAt: new Date('2026-01-01') }])
        .mockResolvedValueOnce([{ active: 1, unsub: 1 }]);

      const result = await service.getSubscribers(TENANT_ID);

      expect(result.activeCount).toBe(1);
      expect(result.unsubscribedCount).toBe(1);
    });
  });

  // ── createCampaign ──────────────────────────────────────────────────────

  describe('createCampaign', () => {
    it('sanitizes text-block html before storing', async () => {
      db.returning.mockResolvedValueOnce([
        { id: 'c1', tenantId: TENANT_ID, subject: 'Нов', blocks: [], status: 'draft', recipientCount: null, priceStotinki: null, sentAt: null, updatedAt: new Date() },
      ]);

      const c = await service.createCampaign(TENANT_ID, {
        subject: 'Нов',
        blocks: [{ type: 'text', html: '<p>x</p><script>evil()</script>' }],
      });

      expect(c.id).toBe('c1');
      const valuesArg = db.values.mock.calls[0][0];
      expect(valuesArg.blocks[0].html).not.toContain('script');
      expect(valuesArg.blocks[0].html).toContain('<p>x</p>');
    });

    it('opts.autoGenerated=true → insert values include autoGenerated:true', async () => {
      db.returning.mockResolvedValueOnce([
        { id: 'c2', tenantId: TENANT_ID, subject: 'Auto', blocks: [], status: 'draft', recipientCount: null, priceStotinki: null, sentAt: null, updatedAt: new Date() },
      ]);

      await service.createCampaign(TENANT_ID, { subject: 'Auto', blocks: [] }, { autoGenerated: true });

      const valuesArg = db.values.mock.calls[0][0];
      expect(valuesArg.autoGenerated).toBe(true);
    });

    it('omitted opts → autoGenerated key absent from insert values', async () => {
      db.returning.mockResolvedValueOnce([
        { id: 'c3', tenantId: TENANT_ID, subject: 'Manual', blocks: [], status: 'draft', recipientCount: null, priceStotinki: null, sentAt: null, updatedAt: new Date() },
      ]);

      await service.createCampaign(TENANT_ID, { subject: 'Manual', blocks: [] });

      const valuesArg = db.values.mock.calls[0][0];
      expect('autoGenerated' in valuesArg).toBe(false);
    });
  });

  // ── quote ────────────────────────────────────────────────────────────────

  describe('quote', () => {
    it('prices a send at the per-recipient rate (200 → 11 ст)', async () => {
      db.limit
        .mockResolvedValueOnce([{ active: 200 }]) // active count
        .mockResolvedValueOnce([{ premium: false }]) // tenant premium
        .mockResolvedValueOnce([{ count: 1200, cost: 66 }]); // month-to-date

      const q = await service.quote(TENANT_ID);

      expect(q.activeCount).toBe(200);
      expect(q.sendCostStotinki).toBe(11);
      expect(q.monthToDateCount).toBe(1200);
      expect(q.monthToDateStotinki).toBe(66);
      expect(q.premium).toBe(false);
    });

    it('premium farm → send cost 0', async () => {
      db.limit
        .mockResolvedValueOnce([{ active: 200 }])
        .mockResolvedValueOnce([{ premium: true }])
        .mockResolvedValueOnce([{ count: 0, cost: 0 }]);

      const q = await service.quote(TENANT_ID);

      expect(q.premium).toBe(true);
      expect(q.sendCostStotinki).toBe(0);
    });
  });

  // ── sendCampaign ──────────────────────────────────────────────────────────

  describe('sendCampaign', () => {
    const draft = {
      id: 'c1',
      tenantId: TENANT_ID,
      subject: 'Тест',
      blocks: [{ type: 'text', html: '<p>Здравей</p>' }],
      status: 'draft',
    };

    it('refuses when the farm is not billable', async () => {
      billing.isBillable.mockResolvedValueOnce(false);
      await expect(service.sendCampaign('c1', TENANT_ID)).rejects.toThrow('Настройте плащане');
      expect(emailService.sendMail).not.toHaveBeenCalled();
      expect(billing.billPush).not.toHaveBeenCalled();
    });

    it('sends to active subscribers, records + bills the push, flips to sent', async () => {
      db.limit
        .mockResolvedValueOnce([draft]) // campaignRow
        .mockResolvedValueOnce([
          { id: 'sub-1', email: 'a@test.bg' },
          { id: 'sub-2', email: 'b@test.bg' },
        ]) // active subscribers
        .mockResolvedValueOnce([{ name: 'Ферма Х', settings: {} }]); // renderOpts tenant

      const r = await service.sendCampaign('c1', TENANT_ID);

      expect(r.sent).toBe(2);
      expect(r.recipients).toBe(2);
      expect(emailService.sendMail).toHaveBeenCalledTimes(2);
      expect(billing.billPush).toHaveBeenCalledWith('push-1');
      // campaign flipped to sent with recipient count
      expect(db.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'sent', recipientCount: 2 }),
      );
    });

    it('each email html carries a per-recipient unsubscribe token', async () => {
      db.limit
        .mockResolvedValueOnce([draft])
        .mockResolvedValueOnce([{ id: 'sub-1', email: 'a@test.bg' }])
        .mockResolvedValueOnce([{ name: 'Ферма Х', settings: {} }]);

      await service.sendCampaign('c1', TENANT_ID);

      const callArg = emailService.sendMail.mock.calls[0][0];
      expect(callArg.html).toContain('/unsubscribe?token=');
      expect(callArg.html).toContain('unsub-token-abc');
      expect(callArg.html).not.toContain('{{UNSUB}}');
      // Gmail/Yahoo bulk rules: List-Unsubscribe header + one-click POST.
      expect(callArg.headers['List-Unsubscribe']).toContain('/unsubscribe?token=');
      expect(callArg.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    });

    it('rejects an already-sent campaign', async () => {
      db.limit.mockResolvedValueOnce([{ ...draft, status: 'sent' }]);
      await expect(service.sendCampaign('c1', TENANT_ID)).rejects.toThrow('вече е изпратен');
    });

    it('rejects a list over the recipient cap', async () => {
      (service as any).maxRecipients = 1;
      db.limit
        .mockResolvedValueOnce([draft])
        .mockResolvedValueOnce([
          { id: 'sub-1', email: 'a@test.bg' },
          { id: 'sub-2', email: 'b@test.bg' },
        ]); // 2 > cap(1)+ ... fetch returns maxRecipients+1 rows
      await expect(service.sendCampaign('c1', TENANT_ID)).rejects.toThrow('твърде голям');
    });
  });

  // ── unsubscribe ────────────────────────────────────────────────────────

  describe('unsubscribe', () => {
    it('sets unsubscribedAt for a valid token pointing to an active subscriber', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-1', typ: 'unsub' });
      db.limit.mockResolvedValue([{ id: 'sub-1', tenantId: TENANT_ID, email: 'a@test.bg', unsubscribedAt: null }]);
      db.returning.mockResolvedValue([{ id: 'sub-1', unsubscribedAt: new Date() }]);

      const result = await service.unsubscribe('valid-token');

      expect(result.success).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it('is idempotent for an already-unsubscribed subscriber', async () => {
      jwtService.verify.mockReturnValue({ sub: 'sub-1', typ: 'unsub' });
      db.limit.mockResolvedValue([{ id: 'sub-1', tenantId: TENANT_ID, email: 'a@test.bg', unsubscribedAt: new Date('2026-01-01') }]);

      const result = await service.unsubscribe('valid-token');

      expect(result.success).toBe(true);
      expect(db.update).not.toHaveBeenCalled();
    });

    it('returns success:false for an invalid token', async () => {
      jwtService.verify.mockImplementation(() => { throw new Error('jwt malformed'); });
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
});
