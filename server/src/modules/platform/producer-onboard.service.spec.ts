import { ProducerOnboardService } from './producer-onboard.service';

const IMG = { mimetype: 'image/jpeg', size: 5, buffer: Buffer.from('x') } as Express.Multer.File;

function makeDb(userRow: { id: string } | undefined) {
  const step: any = {};
  for (const m of ['select', 'from', 'where', 'limit']) step[m] = jest.fn(() => step);
  step.then = (res: (v: unknown) => void) => res(userRow ? [userRow] : []);
  const db: any = {};
  for (const m of ['select', 'from', 'where', 'limit']) db[m] = jest.fn(() => step);
  return db;
}

function make(over: Record<string, unknown> = {}, userRow: { id: string } | undefined = { id: 'u1' }) {
  const deps = {
    farmers: { create: jest.fn().mockResolvedValue({ id: 'f1' }), grantAccess: jest.fn().mockResolvedValue({}) },
    extract: {
      extract: jest.fn().mockResolvedValue([{ name: 'Домати', priceStotinki: 450, unit: 'кг', isActive: true }]),
      extractFromImage: jest.fn().mockResolvedValue([{ name: 'Мед', priceStotinki: 1200, unit: 'бр', isActive: true }]),
    },
    products: { create: jest.fn().mockResolvedValue({ id: 'p1' }) },
    auth: { issueInvite: jest.fn().mockResolvedValue({ link: 'https://x/reset-password?token=t' }) },
    config: { get: jest.fn().mockReturnValue('https://panel.example') },
    ...over,
  };
  const svc = new ProducerOnboardService(
    makeDb(userRow),
    deps.farmers as any,
    deps.extract as any,
    deps.products as any,
    deps.auth as any,
    deps.config as any,
  );
  return { svc, deps };
}

describe('ProducerOnboardService.onboard', () => {
  it('creates the producer, imports the pasted list under their id, and mints an invite link', async () => {
    const { svc, deps } = make();
    const res = await svc.onboard('t1', { name: 'Иван', email: 'ivan@x.bg', pricelistText: 'домати 4.50' }, undefined);
    expect(deps.farmers.create).toHaveBeenCalledWith('t1', { name: 'Иван', phone: undefined });
    expect(deps.products.create).toHaveBeenCalledWith('t1', expect.objectContaining({ farmerId: 'f1' }), 'f1');
    expect(deps.farmers.grantAccess).toHaveBeenCalledWith('t1', 'f1', 'ivan@x.bg');
    expect(deps.auth.issueInvite).toHaveBeenCalledWith('u1', expect.objectContaining({ email: false }));
    expect(res).toEqual({ farmerId: 'f1', productsCreated: 1, inviteLink: 'https://x/reset-password?token=t' });
  });

  it('uses the vision path for a photo and skips the invite when no email', async () => {
    const { svc, deps } = make();
    const res = await svc.onboard('t1', { name: 'Иван' }, IMG);
    expect(deps.extract.extractFromImage).toHaveBeenCalledWith(IMG);
    expect(deps.farmers.grantAccess).not.toHaveBeenCalled();
    expect(res.inviteLink).toBeNull();
    expect(res.productsCreated).toBe(1);
  });

  it('still succeeds with zero products when no price list is given', async () => {
    const { svc, deps } = make();
    const res = await svc.onboard('t1', { name: 'Иван' }, undefined);
    expect(deps.products.create).not.toHaveBeenCalled();
    expect(res.productsCreated).toBe(0);
  });
});
