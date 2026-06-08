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
