import { IsArray, IsString, MaxLength, ArrayMaxSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Per-user side-nav visibility preference. `hidden` lists the keys the farmer
 * chose to hide — item hrefs ("/orders") and whole-group keys ("group:Каталог").
 * Bounded so a malformed/oversized payload can't bloat the row; unknown keys are
 * harmless (the sidebar only acts on keys it recognizes).
 */
export class UpdateNavDto {
  @ApiProperty({ type: [String], description: 'Hidden side-nav keys' })
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(80, { each: true })
  hidden: string[];
}
