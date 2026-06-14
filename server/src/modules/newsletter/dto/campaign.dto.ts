import { IsString, Length, IsArray, ValidateNested, IsIn, ArrayMaxSize } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';
import type { NewsletterBlock } from '@farmflow/types';

const BLOCK_TYPES = ['hero', 'heading', 'text', 'image', 'button', 'columns', 'divider', 'spacer'];

/**
 * Pragmatic block validation: subject is strict; each block must carry a known
 * `type`. Blocks are stored as JSON and the render path sanitizes all html +
 * ignores unknown fields, so a malformed block degrades safely. A new block
 * `type` MUST be added to BLOCK_TYPES above or the whitelist 400s it silently.
 */
class BlockShape {
  @IsString()
  @IsIn(BLOCK_TYPES)
  type: string;
}

export class UpsertCampaignDto {
  @ApiProperty({ example: 'Новини от фермата', maxLength: 200 })
  @IsString()
  @Length(0, 200)
  subject: string;

  @ApiProperty({ type: [Object], description: 'Ordered newsletter blocks' })
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => BlockShape)
  blocks: NewsletterBlock[];
}
