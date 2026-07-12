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

    it('renders pickup orders in their own "За вземане" section', async () => {
      const pickupOrder = {
        id: 'ord-3',
        deliveryType: 'pickup',
        customerName: 'Георги Пейков',
        deliveryAddress: null,
        econtOffice: null,
        slotFrom: '09:00:00',
        slotTo: '11:00:00',
      };
      db.orderBy.mockResolvedValue([pickupOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result).not.toBeNull();
      expect(result!.summary.totalOrders).toBe(1);
      expect(result!.html).toContain('За вземане');
      expect(result!.html).toContain('Георги Пейков');
      expect(result!.html).toContain('09:00');
      expect(result!.text).toContain('За вземане');
      expect(result!.text).toContain('Георги Пейков');
    });

    it('tags a cash-on-delivery order with наложен платеж + total', async () => {
      const codOrder = {
        id: 'ord-cod',
        deliveryType: 'address',
        customerName: 'Стоян Стоянов',
        deliveryAddress: 'ул. Липа 7',
        econtOffice: null,
        slotFrom: null,
        slotTo: null,
        paymentMethod: 'cod',
        totalStotinki: 2599,
      };
      db.orderBy.mockResolvedValue([codOrder]);

      const result = await service.buildDigest(TENANT_ID, TODAY);

      expect(result).not.toBeNull();
      expect(result!.text).toContain('наложен платеж — 25,99 €');
      expect(result!.html).toContain('наложен платеж — 25,99 €');
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

    it('counts courier-split-leg orders toward totalOrders + distinctCustomers even though they render no section', async () => {
      // A 'courier' deliveryType order (created by orders.service's
      // createCourierOrders for a multi-farmer courier split) has no dedicated
      // rendered section, but is still a real confirmed order for the farmer
      // and must count in the summary — see groupFarmerRows' orderList.
      db.orderBy.mockResolvedValueOnce([
        { orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: '10:00:00', slotTo: '12:00:00',
          productName: 'Домати', quantity: 3 },
        { orderId: 'o2', deliveryType: 'courier', customerName: 'Мария', deliveryAddress: 'ул. 2',
          deliveryCity: 'Пловдив', econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Мед', quantity: 1 },
      ]);

      const result = await service.buildFarmerDigest(TENANT_ID, 'farmer-1', TODAY, 'Петър');

      expect(result).not.toBeNull();
      expect(result!.summary.totalOrders).toBe(2);
      expect(result!.summary.distinctCustomers).toBe(2);
      // Rendering itself is unaffected: courier orders still get no
      // "Доставка до адрес"/pickup/econt order block of their own (the prep
      // table above is fed from raw rows regardless of deliveryType, so
      // "Мед" legitimately appears there — only the per-order sections skip it).
      expect(result!.html).not.toContain('Мария');
    });
  });

  // ── eligibleTenantIds ────────────────────────────────────────────────────

  describe('eligibleTenantIds', () => {
    it('returns ids of tenants with email or multiFarmer', async () => {
      db.orderBy.mockResolvedValueOnce([{ id: 'tenant-a' }, { id: 'tenant-b' }]);
      const ids = await service.eligibleTenantIds();
      expect(ids).toEqual(['tenant-a', 'tenant-b']);
    });

    it('returns empty array when no eligible tenants', async () => {
      db.orderBy.mockResolvedValueOnce([]);
      const ids = await service.eligibleTenantIds();
      expect(ids).toEqual([]);
    });
  });

  // ── runForTenant ─────────────────────────────────────────────────────────

  describe('runForTenant', () => {
    it('sends an email when tenant has an email and has orders', async () => {
      // limit(1) → get tenant
      db.limit.mockResolvedValueOnce([{ id: TENANT_ID, email: 'farmer@test.bg', multiFarmer: false }]);
      // buildDigest → orders query
      db.orderBy.mockResolvedValueOnce([{
        id: 'ord-1',
        deliveryType: 'address',
        customerName: 'Тест Клиент',
        deliveryAddress: 'ул. 1',
        econtOffice: null,
        slotFrom: null,
        slotTo: null,
      }]);

      await service.runForTenant(TENANT_ID);

      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'farmer@test.bg' }),
      );
    });

    it('does not send when digest returns null (no orders)', async () => {
      db.limit.mockResolvedValueOnce([{ id: TENANT_ID, email: 'farmer@test.bg', multiFarmer: false }]);
      // buildDigest returns null (no orders)
      db.orderBy.mockResolvedValueOnce([]);

      await service.runForTenant(TENANT_ID);

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it('returns early when tenant does not exist', async () => {
      db.limit.mockResolvedValueOnce([]);

      await expect(service.runForTenant('non-existent')).resolves.toBeUndefined();

      expect(emailService.sendMail).not.toHaveBeenCalled();
    });

    it('sends farmer digests for a multi-farmer tenant with no owner email', async () => {
      // limit(1) → tenant with multiFarmer, no email
      db.limit.mockResolvedValueOnce([{ id: TENANT_ID, email: null, multiFarmer: true }]);
      // farmers-with-email query
      db.orderBy.mockResolvedValueOnce([{ id: 'f1', name: 'Петър', email: 'petar@ferma.bg' }]);
      // batched farmer items query (one read for all farmers, grouped by farmerId)
      db.orderBy.mockResolvedValueOnce([
        { farmerId: 'f1', orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Домати', quantity: 3 },
      ]);

      await service.runForTenant(TENANT_ID);

      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'petar@ferma.bg' }),
      );
    });

    it('batches a single items query for all farmers, grouped by farmerId', async () => {
      db.limit.mockResolvedValueOnce([{ id: TENANT_ID, email: null, multiFarmer: true }]);
      // two farmers with email
      db.orderBy.mockResolvedValueOnce([
        { id: 'f1', name: 'Петър', email: 'petar@ferma.bg' },
        { id: 'f2', name: 'Иван', email: 'ivan@ferma.bg' },
      ]);
      // ONE batched items query returns rows for BOTH farmers (no per-farmer N+1)
      db.orderBy.mockResolvedValueOnce([
        { farmerId: 'f1', orderId: 'o1', deliveryType: 'address', customerName: 'А', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null, productName: 'Мед', quantity: 1 },
        { farmerId: 'f2', orderId: 'o2', deliveryType: 'pickup', customerName: 'Б', deliveryAddress: null,
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null, productName: 'Сирене', quantity: 2 },
      ]);

      await service.runForTenant(TENANT_ID);

      expect(emailService.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'petar@ferma.bg' }));
      expect(emailService.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: 'ivan@ferma.bg' }));
      expect(emailService.sendMail).toHaveBeenCalledTimes(2);
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
        { farmerId: 'f1', orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
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

  // ── Task #14: allTenantIds / sendTomorrowFarmerEmails / runTomorrowForTenant ──

  describe('allTenantIds', () => {
    it('returns every tenant id, unfiltered (unlike eligibleTenantIds)', async () => {
      db.orderBy.mockResolvedValueOnce([{ id: 'tenant-a' }, { id: 'tenant-b' }, { id: 'tenant-c' }]);
      const ids = await service.allTenantIds();
      expect(ids).toEqual(['tenant-a', 'tenant-b', 'tenant-c']);
    });
  });

  describe('sendTomorrowFarmerEmails', () => {
    it('emails every farmer with an email + items TOMORROW, regardless of multiFarmer', async () => {
      // farmers-with-email query
      db.orderBy.mockResolvedValueOnce([{ id: 'f1', name: 'Петър', email: 'petar@ferma.bg' }]);
      // batched farmer items query for tomorrow
      db.orderBy.mockResolvedValueOnce([
        { farmerId: 'f1', orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Домати', quantity: 3 },
      ]);

      const sent = await service.sendTomorrowFarmerEmails(TENANT_ID);

      expect(sent).toBe(1);
      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ to: 'petar@ferma.bg', subject: expect.stringContaining('Утре') }),
      );
    });

    it('testMode=true tags the subject with (тест)', async () => {
      db.orderBy.mockResolvedValueOnce([{ id: 'f1', name: 'Петър', email: 'petar@ferma.bg' }]);
      db.orderBy.mockResolvedValueOnce([
        { farmerId: 'f1', orderId: 'o1', deliveryType: 'pickup', customerName: 'Иван', deliveryAddress: null,
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Мед', quantity: 1 },
      ]);

      await service.sendTomorrowFarmerEmails(TENANT_ID, true);

      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ subject: expect.stringContaining('(тест)') }),
      );
    });

    it('returns 0 and sends nothing when no farmer has items tomorrow', async () => {
      db.orderBy.mockResolvedValueOnce([{ id: 'f1', name: 'Петър', email: 'petar@ferma.bg' }]);
      db.orderBy.mockResolvedValueOnce([]); // no items tomorrow

      const sent = await service.sendTomorrowFarmerEmails(TENANT_ID);

      expect(sent).toBe(0);
      expect(emailService.sendMail).not.toHaveBeenCalled();
    });
  });

  describe('runTomorrowForTenant', () => {
    it('delegates to sendTomorrowFarmerEmails (not testMode)', async () => {
      db.orderBy.mockResolvedValueOnce([{ id: 'f1', name: 'Петър', email: 'petar@ferma.bg' }]);
      db.orderBy.mockResolvedValueOnce([
        { farmerId: 'f1', orderId: 'o1', deliveryType: 'address', customerName: 'Иван', deliveryAddress: 'ул. 1',
          deliveryCity: null, econtOffice: null, slotFrom: null, slotTo: null,
          productName: 'Домати', quantity: 1 },
      ]);

      await service.runTomorrowForTenant(TENANT_ID);

      expect(emailService.sendMail).toHaveBeenCalledWith(
        expect.objectContaining({ subject: expect.not.stringContaining('(тест)') }),
      );
    });
  });
});
