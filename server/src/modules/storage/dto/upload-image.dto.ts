import { ApiProperty } from '@nestjs/swagger';

export const PRODUCT_IMAGE_MIME_REGEX = /^image\/(jpeg|png|webp)$/;

export const PRODUCT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

export const PRODUCT_IMAGE_EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

export class UploadImageDto {
  @ApiProperty({
    type: 'string',
    format: 'binary',
    description: 'Product image file (jpeg, png, or webp; max 5 MB)',
  })
  image: any;
}
