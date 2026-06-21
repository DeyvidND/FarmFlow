import { DemoRequestService } from './demo-request.service';
import { DemoRequestDto } from './dto/demo-request.dto';

describe('DemoRequestService', () => {
  const sendMail = jest.fn();
  const email = { sendMail } as never;
  const cfg = (map: Record<string, string>) =>
    ({ get: (k: string) => map[k] }) as never;

  beforeEach(() => sendMail.mockReset());

  const dto = (over: Partial<DemoRequestDto> = {}): DemoRequestDto => ({
    name: 'Иван',
    email: 'ivan@example.bg',
    ...over,
  });

  it('emails the lead to the operator inbox', async () => {
    const svc = new DemoRequestService(email, cfg({ SUPER_ADMIN_EMAIL: 'ops@example.com' }));
    await expect(
      svc.submit(dto({ farm: 'Слънчо', phone: '0888', message: 'здравейте' })),
    ).resolves.toEqual({ ok: true });

    expect(sendMail).toHaveBeenCalledTimes(1);
    const arg = sendMail.mock.calls[0][0];
    expect(arg.to).toBe('ops@example.com');
    expect(arg.subject).toContain('Иван');
    expect(arg.html).toContain('ivan@example.bg');
    expect(arg.html).toContain('Слънчо');
    expect(arg.html).toContain('0888');
  });

  it('prefers DEMO_LEADS_EMAIL over SUPER_ADMIN_EMAIL', async () => {
    const svc = new DemoRequestService(
      email,
      cfg({ DEMO_LEADS_EMAIL: 'leads@fermeribg.com', SUPER_ADMIN_EMAIL: 'ops@example.com' }),
    );
    await svc.submit(dto());
    expect(sendMail.mock.calls[0][0].to).toBe('leads@fermeribg.com');
  });

  it('falls back to a default inbox when no env is set', async () => {
    const svc = new DemoRequestService(email, cfg({}));
    await svc.submit(dto());
    expect(sendMail.mock.calls[0][0].to).toBe('hello@fermeribg.com');
  });

  it('drops honeypot submissions silently (no email)', async () => {
    const svc = new DemoRequestService(email, cfg({ SUPER_ADMIN_EMAIL: 'ops@example.com' }));
    await expect(svc.submit(dto({ honey: 'gotcha' }))).resolves.toEqual({ ok: true });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('HTML-escapes lead fields (no markup injection into the email body)', async () => {
    const svc = new DemoRequestService(email, cfg({ SUPER_ADMIN_EMAIL: 'ops@example.com' }));
    await svc.submit(dto({ name: '<script>x</script>' }));
    const html = sendMail.mock.calls[0][0].html;
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('omits empty optional rows', async () => {
    const svc = new DemoRequestService(email, cfg({ SUPER_ADMIN_EMAIL: 'ops@example.com' }));
    await svc.submit(dto({ farm: '', phone: '   ' }));
    const html = sendMail.mock.calls[0][0].html;
    expect(html).not.toContain('Ферма');
    expect(html).not.toContain('Телефон');
  });
});
