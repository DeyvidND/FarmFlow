import { IsEmail } from 'class-validator';

export class GrantAccessDto {
  @IsEmail({}, { message: 'Невалиден имейл' })
  email!: string;
}
