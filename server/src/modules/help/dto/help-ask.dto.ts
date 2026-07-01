import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class HelpAskDto {
  @IsIn(['panel', 'delivery'])
  surface!: 'panel' | 'delivery';

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  question!: string;
}
