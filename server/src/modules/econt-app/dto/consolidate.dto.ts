import { IsArray, IsBoolean, IsIn, IsOptional, IsUUID, ArrayMinSize } from 'class-validator';

export class ConsolidateDto {
  @IsUUID()
  collectorFarmerId!: string;

  @IsArray()
  @ArrayMinSize(2)
  @IsUUID('all', { each: true })
  memberOrderIds!: string[];

  @IsOptional()
  @IsIn(['econt', 'speedy'])
  carrier?: 'econt' | 'speedy';
}

export class ConsolidationToggleDto {
  @IsBoolean()
  enabled!: boolean;
}
