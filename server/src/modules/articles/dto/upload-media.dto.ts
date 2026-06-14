import { ApiProperty } from '@nestjs/swagger';

// Article images (cover + inline) are image-only — video/embed routes were dropped.
export const ARTICLE_COVER_MIME_REGEX = /^image\/(jpeg|png|webp)$/;
export const ARTICLE_COVER_MAX_BYTES = 5 * 1024 * 1024;

export const ARTICLE_IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class UploadArticleMediaDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'Image: jpeg/png/webp, ≤5 MB',
  })
  file: any;
}
