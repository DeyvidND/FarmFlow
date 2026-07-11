import { DigestController } from './digest.controller';

describe('DigestController.sendFarmerOrders', () => {
  it('delegates to the service with tenant + body', async () => {
    const service = {
      sendFarmerOrderEmails: jest.fn().mockResolvedValue({ sent: 2, skipped: 1 }),
    } as any;
    const controller = new DigestController(service);
    const body = { from: '2026-07-10', to: '2026-07-12', farmerIds: ['f1'], statuses: ['confirmed'] };
    const res = await controller.sendFarmerOrders('tenant-1', body as any);
    expect(service.sendFarmerOrderEmails).toHaveBeenCalledWith('tenant-1', body);
    expect(res).toEqual({ sent: 2, skipped: 1 });
  });
});
