import { OperatorDigestService } from './operator-digest.service';

function makeSvc(opts: {
  superAdminEmail?: string | null;
  signals?: unknown[];
  stuckDrafts?: unknown[];
  emailTotals?: unknown;
  pulse?: unknown;
}) {
  const email = { sendMail: jest.fn().mockResolvedValue(undefined) };
  const insights = { insights: jest.fn().mockResolvedValue({ signals: opts.signals ?? [] }) };
  const platform = {
    deliveryOps: jest.fn().mockResolvedValue({ stuckDrafts: opts.stuckDrafts ?? [] }),
    emailBilling: jest.fn().mockResolvedValue({ totals: opts.emailTotals ?? { recipientTotal: 0, revenueStotinki: 0, costStotinki: 0, marginStotinki: 0 } }),
  };
  const config = { get: (k: string) => (k === 'SUPER_ADMIN_EMAIL' ? (opts.superAdminEmail ?? '') : undefined) };
  const db = {} as any;
  const svc = new OperatorDigestService(db, insights as any, platform as any, email as any, config as any);
  // Override the DB-bound pulse query so the service tests need no database.
  (svc as any).dailyPulse = jest.fn().mockResolvedValue(
    opts.pulse ?? { orders24h: 0, revenue24hStotinki: 0, newSignups: [] },
  );
  return { svc, email, insights, platform };
}

describe('OperatorDigestService.runDaily', () => {
  it('skips when no SUPER_ADMIN_EMAIL is configured', async () => {
    const { svc, email } = makeSvc({ superAdminEmail: '', pulse: { orders24h: 5, revenue24hStotinki: 1000, newSignups: [] } });
    const res = await svc.runDaily();
    expect(res).toEqual({ sent: false, reason: 'no-recipient' });
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('skips a fully-quiet day without sending', async () => {
    const { svc, email } = makeSvc({ superAdminEmail: 'op@ferma.bg' });
    const res = await svc.runDaily();
    expect(res).toEqual({ sent: false, reason: 'empty' });
    expect(email.sendMail).not.toHaveBeenCalled();
  });

  it('sends to the operator when there is something to report', async () => {
    const { svc, email } = makeSvc({
      superAdminEmail: 'op@ferma.bg',
      signals: [{ name: 'Ферма А', phone: '0888000000', signals: [{ key: 'empty_shop', label: 'Няма продукти', action: 'Качи продукти', severity: 90 }] }],
    });
    const res = await svc.runDaily();
    expect(res).toEqual({ sent: true });
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    const arg = email.sendMail.mock.calls[0][0];
    expect(arg.to).toBe('op@ferma.bg');
    expect(arg.subject).toContain('Дневен отчет');
    expect(arg.html).toContain('Ферма А');
    expect(arg.html).toContain('0888000000');
  });

  it('still sends a partial report when one section query throws', async () => {
    const { svc, email, platform } = makeSvc({
      superAdminEmail: 'op@ferma.bg',
      signals: [{ name: 'Ферма А', phone: '0888000000', signals: [{ label: 'Няма продукти', action: 'Качи продукти' }] }],
    });
    // emailBilling blows up — the attention list must still reach the operator.
    platform.emailBilling.mockRejectedValue(new Error('billing query down'));

    const res = await svc.runDaily();

    expect(res).toEqual({ sent: true });
    expect(email.sendMail).toHaveBeenCalledTimes(1);
    expect(email.sendMail.mock.calls[0][0].html).toContain('Ферма А');
  });

  it('treats every section failing as a quiet day (no send, no crash)', async () => {
    const { svc, email, insights, platform } = makeSvc({ superAdminEmail: 'op@ferma.bg' });
    insights.insights.mockRejectedValue(new Error('insights down'));
    platform.deliveryOps.mockRejectedValue(new Error('deliveryOps down'));
    platform.emailBilling.mockRejectedValue(new Error('billing down'));
    (svc as any).dailyPulse = jest.fn().mockRejectedValue(new Error('pulse down'));

    const res = await svc.runDaily();

    expect(res).toEqual({ sent: false, reason: 'empty' });
    expect(email.sendMail).not.toHaveBeenCalled();
  });
});
