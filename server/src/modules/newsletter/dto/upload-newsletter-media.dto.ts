import { ApiProperty } from '@nestjs/swagger';

export const NEWSLETTER_IMG_MIME_REGEX = /^(image\/(jpeg|png|webp))$/;
export const NEWSLETTER_IMG_MAX_BYTES = 8 * 1024 * 1024; // 8 MB

export class UploadNewsletterMediaDto {
  @ApiProperty({ type: 'string', format: 'binary' })
  file: unknown;
}
