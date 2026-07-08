import { ArrayMaxSize, ArrayMinSize, IsArray, Matches } from 'class-validator';

/** Days (YYYY-MM-DD) to spread the tenant's pending address orders across. */
export class SuggestDaysDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(14)
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { each: true, message: 'всяка дата трябва да е YYYY-MM-DD' })
  days!: string[];
}
