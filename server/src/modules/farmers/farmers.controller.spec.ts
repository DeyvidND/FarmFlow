import { FarmersController } from './farmers.controller';

describe('FarmersController.findAll role strip', () => {
  const row = {
    id: 'f1', tenantId: 't1', name: 'Васил',
    commissionRateBps: 500, subscriptionFeeStotinki: 1200,
    internalNotes: 'таен', payout: { iban: 'BG80', holder: 'Васил' },
  };

  it('strips operator-only fields for the farmer sub-account role', async () => {
    const svc = { findAll: jest.fn().mockResolvedValue([{ ...row }]) } as any;
    const ctrl = new FarmersController(svc);
    const out = await ctrl.findAll('t1', { role: 'farmer', farmerId: 'f1' } as any);
    expect(out[0]).not.toHaveProperty('commissionRateBps');
    expect(out[0]).not.toHaveProperty('subscriptionFeeStotinki');
    expect(out[0]).not.toHaveProperty('internalNotes');
    expect(out[0]).not.toHaveProperty('payout');
    expect(out[0]).toHaveProperty('name', 'Васил');
  });

  it('leaves everything for the admin/owner role', async () => {
    const svc = { findAll: jest.fn().mockResolvedValue([{ ...row }]) } as any;
    const ctrl = new FarmersController(svc);
    const out = await ctrl.findAll('t1', { role: 'admin' } as any);
    expect(out[0]).toHaveProperty('internalNotes', 'таен');
    expect(out[0]).toHaveProperty('payout');
  });
});
