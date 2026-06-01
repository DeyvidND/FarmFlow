import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdateReviewStatusDto {
  @ApiProperty({ enum: ['pending', 'published', 'hidden'] })
  @IsIn(['pending', 'published', 'hidden'])
  status: 'pending' | 'published' | 'hidden';
}
