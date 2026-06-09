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
