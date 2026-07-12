import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { OnboardProducerDto } from './onboard-producer.dto';

// The onboarding form posts multipart/form-data — every untouched optional text
// field arrives as '', not absent. @IsOptional() alone skips only null/undefined,
// so a bare '' used to reach @IsEmail() and 400 a field advertised as optional.
describe('OnboardProducerDto blank-string optional fields', () => {
  it('accepts blank email/phone/pricelistText and normalises them to undefined', async () => {
    const dto = plainToInstance(OnboardProducerDto, { name: 'Иван', email: '', phone: '', pricelistText: '' });
    const errs = await validate(dto);
    expect(errs).toHaveLength(0);
    expect(dto.email).toBeUndefined();
    expect(dto.phone).toBeUndefined();
    expect(dto.pricelistText).toBeUndefined();
  });

  it('still rejects a non-empty malformed email with the BG message', async () => {
    const dto = plainToInstance(OnboardProducerDto, { name: 'Иван', email: 'not-an-email' });
    const errs = await validate(dto);
    const emailErr = errs.find((e) => e.property === 'email');
    expect(emailErr?.constraints?.isEmail).toBe('Невалиден имейл.');
  });
});
