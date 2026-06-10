// Back-compat aliases — the media-gallery reorder endpoints predate the generic
// `ReorderDto`. Keep the old names pointing at the shared definitions so those
// controllers/services need no change.
export { ReorderItemDto as ReorderMediaItemDto, ReorderDto as ReorderMediaDto } from './reorder.dto';
