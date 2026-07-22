import { OrderProtocolEmailProcessor } from './order-protocol-email.processor';

function job(data: { tenantId: string; orderId: string }) {
  return { id: 'job-1', data } as any;
}

describe('OrderProtocolEmailProcessor', () => {
  it('calls sendProtocolEmail with the job payload and resolves on ok:true', async () => {
    const svc = { sendProtocolEmail: jest.fn().mockResolvedValue({ ok: true }) };
    const processor = new OrderProtocolEmailProcessor(svc as any);

    await expect(processor.process(job({ tenantId: 't1', orderId: 'o1' }))).resolves.toBeUndefined();
    expect(svc.sendProtocolEmail).toHaveBeenCalledWith('t1', 'o1');
  });

  it('throws on ok:false so BullMQ applies its configured retry/backoff', async () => {
    const svc = { sendProtocolEmail: jest.fn().mockResolvedValue({ ok: false, error: 'SMTP timeout' }) };
    const processor = new OrderProtocolEmailProcessor(svc as any);

    await expect(processor.process(job({ tenantId: 't1', orderId: 'o1' }))).rejects.toThrow('SMTP timeout');
  });

  it('does NOT throw on a skipped outcome (no-email / already-sent) — that is success, not failure', async () => {
    const svc = { sendProtocolEmail: jest.fn().mockResolvedValue({ ok: true, skipped: 'already-sent' }) };
    const processor = new OrderProtocolEmailProcessor(svc as any);

    await expect(processor.process(job({ tenantId: 't1', orderId: 'o1' }))).resolves.toBeUndefined();
  });
});
