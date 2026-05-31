import { ApiProperty } from '@nestjs/swagger';

// Cover is image-only (mirrors product images). Article media additionally allows video.
export const ARTICLE_COVER_MIME_REGEX = /^image\/(jpeg|png|webp)$/;
export const ARTICLE_COVER_MAX_BYTES = 5 * 1024 * 1024;

export const ARTICLE_MEDIA_MIME_REGEX = /^(image\/(jpeg|png|webp)|video\/(mp4|webm))$/;
export const ARTICLE_MEDIA_MAX_BYTES = 50 * 1024 * 1024;

export const ARTICLE_MEDIA_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
};

/** image|video block type derived from the uploaded file's mime. */
export function articleMediaTypeForMime(mime: string): 'image' | 'video' {
  return mime.startsWith('video/') ? 'video' : 'image';
}

export class UploadArticleMediaDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'Image (jpeg/png/webp, ≤5 MB cover) or video (mp4/webm, ≤50 MB media)',
  })
  file: any;
}
