/**
 * Which upload a job services — maps 1:1 to a service finisher method.
 *
 * Scope is limited to entity images that are STORED to a column/table and
 * displayed later (cover + gallery for products / farmers / subcategories), so an
 * upload can return immediately and the optimize happens on a worker. Inline
 * editor uploads (article WYSIWYG, newsletter block images) and slot-keyed tenant
 * site media are intentionally NOT queued — their callers need the final URL
 * synchronously to embed it, so they stay synchronous.
 */
export type ImageEntityType =
  | 'product-cover'
  | 'product-media'
  | 'farmer-cover'
  | 'farmer-media'
  | 'subcategory-cover'
  | 'subcategory-media';

export interface ImageJobPayload {
  entityType: ImageEntityType;
  /** The owning row id (product/farmer/subcategory id). */
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
