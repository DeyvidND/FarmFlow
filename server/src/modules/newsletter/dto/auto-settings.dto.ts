import { IsBoolean } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AutoSettingsDto {
  @ApiProperty()
  @IsBoolean()
  enabled: boolean;
}
