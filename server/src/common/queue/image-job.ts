/** Which upload a job services — maps 1:1 to a service finisher method. */
export type ImageEntityType =
  | 'product-cover'
  | 'product-media'
  | 'farmer-cover'
  | 'farmer-secondary'
  | 'subcategory-cover'
  | 'subcategory-secondary'
  | 'tenant-image'
  | 'article-image'
  | 'newsletter-image';

export interface ImageJobPayload {
  entityType: ImageEntityType;
  /** The owning row id (product/farmer/... id). */
  entityId: string;
  tenantId: string;
  /** Original upload bytes, base64. Decoded by the worker, then optimized. */
  bufferB64: string;
  mime: string;
}

/** Build a payload from a Multer file. Kept tiny + pure so callers stay one-liners. */
export function encodeImageJob(
  entityType: ImageJobPayload['entityType'],
  entityId: string,
  tenantId: string,
  file: { buffer: Buffer; mimetype: string },
): ImageJobPayload {
  return {
    entityType,
    entityId,
    tenantId,
    bufferB64: file.buffer.toString('base64'),
    mime: file.mimetype,
  };
}
