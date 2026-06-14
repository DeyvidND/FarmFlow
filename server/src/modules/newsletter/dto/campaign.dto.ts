import { IsString, Length, IsArray, ArrayMaxSize } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import type { NewsletterBlock } from '@farmflow/types';

/**
 * Pragmatic block validation: subject is strict; `blocks` is validated only as an
 * array (cap its size). We deliberately do NOT @ValidateNested/@Type the items:
 * the global ValidationPipe runs `forbidNonWhitelisted`, which would 400 every
 * block-specific field (image/text/html/…) of a nested validated class. Blocks
 * are stored as JSON and the render path (renderEmail) sanitizes all html and
 * ignores unknown fields, so a malformed block degrades safely.
 */
export class UpsertCampaignDto {
  @ApiProperty({ example: 'Новини от фермата', maxLength: 200 })
  @IsString()
  @Length(0, 200)
  subject: string;

  @ApiProperty({ type: [Object], description: 'Ordered newsletter blocks' })
  @IsArray()
  @ArrayMaxSize(200)
  blocks: NewsletterBlock[];
}
