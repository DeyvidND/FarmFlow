import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EmailService } from './email.service';
import { SuppressionService } from './suppression.service';

const makeSuppression = () =>
  ({ isSuppressed: jest.fn().mockResolvedValue(false), filterSuppressed: jest.fn().mockResolvedValue(new Set()), suppress: jest.fn() }) as unknown as SuppressionService;

// Top-level mock: hoisted before imports by Jest; makes createTransport writable.
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: jest.fn().mockResolvedValue({}) })),
}));
// Import AFTER jest.mock so we get the mocked version.
import * as nodemailer from 'nodemailer';

// ── helpers ────────────────────────────────────────────────────────────────────

function makeConfigService(overrides: Record<string, string | number | undefined> = {}) {
  return {
    get: jest.fn((key: string) => overrides[key]),
    getOrThrow: jest.fn((key: string) => {
      if (overrides[key] === undefined) throw new Error(`Missing ${key}`);
      return overrides[key];
    }),
  } as unknown as ConfigService;
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('EmailService — dev preview transport (no SMTP_HOST)', () => {
  let service: EmailService;
  let previewDir: string;

  beforeEach(async () => {
    previewDir = path.join(os.tmpdir(), `farmflow-mail-test-${Date.now()}`);
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: makeConfigService({ MAIL_PREVIEW_DIR: previewDir }),
        },
        { provide: SuppressionService, useValue: makeSuppression() },
      ],
    }).compile();

    service = module.get(EmailService);
    service.onModuleInit();
  });

  afterEach(async () => {
    // Clean up preview dir.
    await fs.promises.rm(previewDir, { recursive: true, force: true });
  });

  it('resolves without throwing', async () => {
    await expect(
      service.sendMail({ to: 'farmer@test.bg', subject: 'Test', html: '<p>Hello</p>' }),
    ).resolves.toBeUndefined();
  });

  it('writes an HTML file to the preview dir', async () => {
    await service.sendMail({
      to: 'farmer@test.bg',
      subject: 'Weekly digest',
      html: '<p>Your orders</p>',
    });

    const files = await fs.promises.readdir(previewDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.html$/);

    const content = await fs.promises.readFile(path.join(previewDir, files[0]), 'utf8');
    expect(content).toContain('farmer@test.bg');
    expect(content).toContain('Weekly digest');
    expect(content).toContain('<p>Your orders</p>');
  });
});

describe('EmailService — SMTP transport (SMTP_HOST set)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls nodemailer.createTransport with the configured host', async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailService,
        {
          provide: ConfigService,
          useValue: makeConfigService({
            SMTP_HOST: 'smtp.example.com',
            SMTP_PORT: 465,
            SMTP_USER: 'user@example.com',
            SMTP_PASS: 'secret',
          }),
        },
        { provide: SuppressionService, useValue: makeSuppression() },
      ],
    }).compile();

    const svc = module.get(EmailService);
    svc.onModuleInit();

    expect(nodemailer.createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'smtp.example.com' }),
    );
  });
});
