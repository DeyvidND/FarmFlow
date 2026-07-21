import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import { MAX_COMMISSION_BPS } from '../stats.settings';

/** Категориите живеят тук, а не в pg enum — нова категория не бива да иска миграция. */
export const EXPENSE_CATEGORIES = ['fuel', 'packaging', 'salary', 'fees', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Под int4 тавана (2 147 483 647 стотинки) с място за сборове. */
const MAX_AMOUNT_STOTINKI = 2_000_000_000;

/** `@IsOptional()` НЕ превръща '' в undefined — празното поле от формата иначе
 *  минава като празен низ и се записва като празна бележка/куриер. */
const emptyToUndefined = Transform(({ value }) => (value === '' ? undefined : value));

export class CreateExpenseDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалидна дата' })
  date!: string;

  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_STOTINKI)
  amountStotinki!: number;

  @IsIn(EXPENSE_CATEGORIES as unknown as string[])
  category!: ExpenseCategory;

  @IsOptional()
  @emptyToUndefined
  @IsUUID()
  courierAccountId?: string;

  @IsOptional()
  @emptyToUndefined
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class UpdateExpenseDto {
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалидна дата' })
  date?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_STOTINKI)
  amountStotinki?: number;

  @IsOptional()
  @IsIn(EXPENSE_CATEGORIES as unknown as string[])
  category?: ExpenseCategory;

  /** `null` изрично отвързва разхода от куриер (прави го общ). `declare`, за да не
   *  emit-ва TS field initializer (ES2022 `useDefineForClassFields`) — иначе
   *  `plainToInstance` слага own-property на ВСЯКА инстанция, дори когато клиентът
   *  изобщо не е пратил ключа, и `'courierAccountId' in dto` в сървиса винаги е true. */
  @IsOptional()
  @emptyToUndefined
  @IsUUID()
  declare courierAccountId?: string | null;

  @IsOptional()
  @emptyToUndefined
  @IsString()
  @MaxLength(300)
  note?: string;
}

export class ExpenseQueryDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалиден период' })
  from!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'Невалиден период' })
  to!: string;
}

export class SetCommissionDto {
  @IsInt()
  @Min(0)
  @Max(MAX_COMMISSION_BPS)
  bps!: number;
}
