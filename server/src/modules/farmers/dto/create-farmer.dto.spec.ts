import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { CreateFarmerDto } from './create-farmer.dto';

function errorsFor(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreateFarmerDto, payload));
}

describe('CreateFarmerDto — email', () => {
  it('accepts a valid email', async () => {
    const errs = await errorsFor({ name: 'Петър', email: 'petar@ferma.bg' });
    expect(errs).toHaveLength(0);
  });

  it('rejects an invalid email', async () => {
    const errs = await errorsFor({ name: 'Петър', email: 'not-an-email' });
    expect(errs.some((e) => e.property === 'email')).toBe(true);
  });

  it('allows omitting email', async () => {
    const errs = await errorsFor({ name: 'Петър' });
    expect(errs).toHaveLength(0);
  });
});

describe('CreateFarmerDto — string length caps', () => {
  it('accepts strings within bounds', async () => {
    const errs = await errorsFor({
      name: 'П'.repeat(200),
      role: 'Р'.repeat(120),
      bio: 'Б'.repeat(5000),
      phone: '0'.repeat(40),
      since: '2'.repeat(40),
      tint: '#'.repeat(40),
    });
    expect(errs).toHaveLength(0);
  });

  it.each([
    ['name', 201],
    ['role', 121],
    ['bio', 5001],
    ['phone', 41],
    ['since', 41],
    ['tint', 41],
  ])('rejects an over-long %s', async (field, len) => {
    const errs = await errorsFor({ name: 'Петър', [field]: 'x'.repeat(len) });
    expect(errs.some((e) => e.property === field)).toBe(true);
  });
});

describe('CreateFarmerDto — coverCrop', () => {
  it('accepts a valid focal point + zoom', async () => {
    const errs = await errorsFor({ name: 'Петър', coverCrop: { x: 0.2, y: 0.8, zoom: 1.5 } });
    expect(errs).toHaveLength(0);
  });

  it('accepts null (clears the framing)', async () => {
    const errs = await errorsFor({ name: 'Петър', coverCrop: null });
    expect(errs).toHaveLength(0);
  });

  it('allows omitting coverCrop', async () => {
    const errs = await errorsFor({ name: 'Петър' });
    expect(errs).toHaveLength(0);
  });

  it('rejects a focal point outside 0..1', async () => {
    const errs = await errorsFor({ name: 'Петър', coverCrop: { x: 1.4, y: 0.5, zoom: 1 } });
    expect(errs.some((e) => e.property === 'coverCrop')).toBe(true);
  });

  it('rejects zoom outside 1..3', async () => {
    const errs = await errorsFor({ name: 'Петър', coverCrop: { x: 0.5, y: 0.5, zoom: 5 } });
    expect(errs.some((e) => e.property === 'coverCrop')).toBe(true);
  });

  it('rejects a non-numeric focal point', async () => {
    const errs = await errorsFor({ name: 'Петър', coverCrop: { x: 'left', y: 0.5, zoom: 1 } });
    expect(errs.some((e) => e.property === 'coverCrop')).toBe(true);
  });
});

describe('CreateFarmerDto — profile v1 fields', () => {
  it('accepts story, internalNotes and a valid payout', async () => {
    const dto = plainToInstance(CreateFarmerDto, {
      name: 'Петър',
      story: 'Дълъг разказ за фермата…',
      internalNotes: 'обажда се преди доставка',
      payout: { iban: 'BG80BNBG96611020345678', holder: 'Петър Петров' },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects a malformed IBAN', async () => {
    const dto = plainToInstance(CreateFarmerDto, {
      name: 'Петър',
      payout: { iban: 'NOT-AN-IBAN' },
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('CreateFarmerDto — optional email/imageUrl empty-string clear', () => {
  // @IsOptional() only skips null/undefined, so without a @Transform a '' reaches
  // @IsEmail()/@IsUrl() and 400s a field documented as optional (the repo's recurring
  // ''-vs-undefined gotcha — first hit on the chaika checkout email). Sending ''
  // should CLEAR the field, mirroring create-order.dto customerEmail.
  it('treats an empty email as absent (blank → undefined), not a 400', async () => {
    const dto = plainToInstance(CreateFarmerDto, { name: 'Петър', email: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(false);
    expect(dto.email).toBeUndefined();
  });

  it('treats a whitespace-only email as absent', async () => {
    const dto = plainToInstance(CreateFarmerDto, { name: 'Петър', email: '   ' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(false);
    expect(dto.email).toBeUndefined();
  });

  it('treats an empty imageUrl as absent (blank → undefined), not a 400', async () => {
    const dto = plainToInstance(CreateFarmerDto, { name: 'Петър', imageUrl: '' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'imageUrl')).toBe(false);
    expect(dto.imageUrl).toBeUndefined();
  });

  it('still accepts a real email + imageUrl', async () => {
    const dto = plainToInstance(CreateFarmerDto, {
      name: 'Петър',
      email: 'petar@ferma.bg',
      imageUrl: 'https://x.bg/a.jpg',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('still REJECTS a non-empty invalid email (transform only blanks empty strings)', async () => {
    const dto = plainToInstance(CreateFarmerDto, { name: 'Петър', email: 'not-an-email' });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'email')).toBe(true);
  });
});
