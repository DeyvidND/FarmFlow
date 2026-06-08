// server/src/modules/digest/digest.service.spec.ts
import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { DigestService } from './digest.service';
import { EmailService } from '../../common/email/email.service';
import { DB_TOKEN } from '../../common/drizzle/drizzle.constants';

// ── Mock DB builder ─────────────────────────────────────────────────────────
function makeDb() {
  return {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockResolvedValue([]),
  };
}

function makeEmailService() {
  return { sendMail: jest.fn().mockResolvedValue(undefined) };
}

const TENANT_ID = 'tenant-uuid-1';
const TODAY = '2026-06-03';

describe('DigestService', () => {
  let service: DigestService;
  let db: ReturnType<typeof makeDb>;
  let emailService: ReturnType<typeof makeEmailService>;

  beforeEach(async () => {
    db = makeDb();
    emailService = makeEmailService();
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DigestService,
        { provide: DB_TOKEN, useValue: db },
        { provide: EmailService, useValue: emailService },
      ],
    }).compile();

    service = module.get(DigestService);
    // Suppress logger noise in tests
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  });

  // ── buildDigest ─────────────────────────────────────────────────────────

  describe('buildDigest', () => {
    it('returns null when there are no confirmed orders for the date', async () => {
      // DB query returns empty array for orders
      db.orderBy.mockResolvedValue([]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result).toBeNull();
    });

    it('splits address orders vs econt orders into the correct groups', async () => {
      const addressOrder = {
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Иван Иванов',
        deliveryAddress: 'ул. Роза 5, София',
        econtOffice: null,
        slotFrom: '10:00:00',
        slotTo: '12:00:00',
      };
      const econtOrder = {
        id: 'ord-2',
        deliveryType: 'econt',
        customerName: 'Мария Петрова',
        deliveryAddress: null,
        econtOffice: 'Офис Пловдив Център',
        slotFrom: null,
        slotTo: null,
      };
      db.orderBy.mockResolvedValue([addressOrder, econtOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result).not.toBeNull();
      expect(result!.summary.selfDeliveryCount).toBe(1);
      expect(result!.summary.econtCount).toBe(1);
      expect(result!.summary.totalOrders).toBe(2);
      expect(result!.summary.distinctCustomers).toBe(2);
    });

    it('generates html containing customer names', async () => {
      const addressOrder = {
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Иван Иванов',
        deliveryAddress: 'ул. Роза 5, София',
        econtOffice: null,
        slotFrom: '10:00:00',
        slotTo: '12:00:00',
      };
      db.orderBy.mockResolvedValue([addressOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result!.html).toContain('Иван Иванов');
      expect(result!.text).toContain('Иван Иванов');
    });

    it('generates html containing econt office name', async () => {
      const econtOrder = {
        id: 'ord-1',
        deliveryType: 'econt',
        customerName: 'Мария Петрова',
        deliveryAddress: null,
        econtOffice: 'Офис Пловдив Център',
        slotFrom: null,
        slotTo: null,
      };
      db.orderBy.mockResolvedValue([econtOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result!.html).toContain('Офис Пловдив Център');
      expect(result!.text).toContain('Офис Пловдив Център');
    });

    it('includes slot time range for address orders that have a slot', async () => {
      const addressOrder = {
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Иван Иванов',
        deliveryAddress: 'ул. Роза 5',
        econtOffice: null,
        slotFrom: '10:00:00',
        slotTo: '12:00:00',
      };
      db.orderBy.mockResolvedValue([addressOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result!.html).toContain('10:00');
      expect(result!.html).toContain('12:00');
    });
  });

  // ── buildFarmerDigest ─────────────────────────────────────────────────────
  describe('buildFarmerDigest', () => {
    it('returns null when the farmer has no items that day', async () => {
      db.orderBy.mockResolvedValueOnce([]);
      const result = await service.buildFarmerDigest(TENANT_ID, 'farmer-1', TODAY, 'Петър');
      expect(result).toBeNull();
    });

    it('renders pickup orders in their own section', async () => {
      db.orderBy.mockResolvedValueOnce([
        { orderId: 'o3', deliveryType: 'pickup', customerName: 'Георги', deliveryAddress: null,
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Мед', quantity: 1 },
      ]);
      const result = await service.buildFarmerDigest(TENANT_ID, 'farmer-1', TODAY, 'Петър');
      expect(result).not.toBeNull();
      expect(result!.summary.totalOrders).toBe(1);
      expect(result!.html).toContain('За вземане');
      expect(result!.html).toContain('Георги');
      expect(result!.html).toContain('Мед');
      expect(result!.text).toContain('За вземане');
    });

    it('builds a prep summary + per-order items for the farmer', async () => {
      db.orderBy.mockResolvedValueOnce([
        { orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: '10:00:00', slotTo: '12:00:00',
          productName: 'Домати', quantity: 3 },
        { orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: '10:00:00', slotTo: '12:00:00',
          productName: 'Краставици', quantity: 2 },
        { orderId: 'o2', deliveryType: 'econt', customerName: 'Мария', deliveryAddress: null,
          deliveryCity: null, econtOffice: 'Офис Пловдив', slotFrom: null, slotTo: null,
          productName: 'Домати', quantity: 5 },
      ]);

      const result = await service.buildFarmerDigest(TENANT_ID, 'farmer-1', TODAY, 'Петър');

      expect(result).not.toBeNull();
      expect(result!.summary.totalOrders).toBe(2);
      // prep summary: Домати 3+5 = 8, Краставици 2
      expect(result!.html).toContain('Домати');
      expect(result!.html).toContain('Краставици');
      expect(result!.text).toContain('8'); // tomato total
      // delivery breakdown shows customers + econt destination
      expect(result!.html).toContain('Иван');
      expect(result!.html).toContain('Офис Пловдив');
    });
  });

  // ── runDailyDigests ─────────────────────────────────────────────────────

  describe('runDailyDigests', () => {
    it('sends an email when a tenant has a non-null email and has orders', async () => {
      const tenantRow = { id: TENANT_ID, email: 'farmer@test.bg' };
      // First call: get all tenants with email
      db.orderBy.mockResolvedValueOnce([tenantRow]);
      // Second call: buildDigest → orders query
      const addressOrder = {
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Тест Клиент',
        deliveryAddress: 'ул. 1',
        econtOffice: null,
        slotFrom: null,
        slotTo: null,
      };
      db.orderBy.mockResolvedValueOnce([addressOrder]);

      await service.runDailyDigests();

      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'farmer@test.bg' }),
      );
    });

    it('does not send when digest returns null (no orders)', async () => {
      const tenantRow = { id: TENANT_ID, email: 'farmer@test.bg' };
      db.orderBy.mockResolvedValueOnce([tenantRow]);
      // buildDigest returns null (no orders)
      db.orderBy.mockResolvedValueOnce([]);

      await service.runDailyDigests();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it('catches error for one tenant and continues to the next', async () => {
      const tenant1 = { id: 'tenant-1', email: 'farmer1@test.bg' };
      const tenant2 = { id: 'tenant-2', email: 'farmer2@test.bg' };
      db.orderBy.mockResolvedValueOnce([tenant1, tenant2]);

      // tenant1 buildDigest throws
      db.orderBy
        .mockRejectedValueOnce(new Error('DB error for tenant 1'))
        // tenant2 buildDigest succeeds with one order
        .mockResolvedValueOnce([
          {
            id: 'ord-1',
            deliveryType: 'address',
            customerName: 'Клиент 2',
            deliveryAddress: 'ул. 2',
            econtOffice: null,
            slotFrom: null,
            slotTo: null,
          },
        ]);

      await expect(service.runDailyDigests()).resolves.toBeUndefined();

      // Only tenant2 email sent
      expect(emailService.sendMail).toHaveBeenCalledTimes(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'farmer2@test.bg' }),
      );
    });

    it('sends farmer digests for a multi-farmer tenant with no owner email', async () => {
      // tenant query: multiFarmer on, no owner email
      db.orderBy.mockResolvedValueOnce([{ id: TENANT_ID, email: null, multiFarmer: true }]);
      // farmers-with-email query
      db.orderBy.mockResolvedValueOnce([{ id: 'f1', name: 'Петър', email: 'petar@ferma.bg' }]);
      // buildFarmerDigest items query
      db.orderBy.mockResolvedValueOnce([
        { orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Домати', quantity: 3 },
      ]);

      await service.runDailyDigests();

      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'petar@ferma.bg' }),
      );
    });
  });

  // ── sendTestDigest ────────────────────────────────────────────────────────
  describe('sendTestDigest', () => {
    it('returns no-email + farmersSent=0 when tenant has no email and multiFarmer is false', async () => {
      db.limit.mockResolvedValueOnce([{ email: null, multiFarmer: false }]);

      const result = await service.sendTestDigest(TENANT_ID);

      expect(result).toEqual({ sent: false, reason: 'no-email', farmersSent: 0 });
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it('sends farmer test digests (no owner email) and reports farmersSent', async () => {
      db.limit.mockResolvedValueOnce([{ email: null, multiFarmer: true }]);
      db.orderBy.mockResolvedValueOnce([{ id: 'f1', name: 'Петър', email: 'petar@ferma.bg' }]);
      db.orderBy.mockResolvedValueOnce([
        { orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Домати', quantity: 2 },
      ]);

      const result = await service.sendTestDigest(TENANT_ID);

      expect(result).toEqual({ sent: false, reason: 'no-email', farmersSent: 1 });
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'petar@ferma.bg', subject: expect.stringContaining('(тест)') }),
      );
    });
  });
});
