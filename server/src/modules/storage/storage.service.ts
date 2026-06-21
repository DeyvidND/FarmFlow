export abstract class StorageService {
  abstract upload(
    file: Buffer,
    key: string,
    contentType: string,
  ): Promise<{ key: string; url: string }>;

  abstract delete(key: string): Promise<void>;

  /** Delete every object under a key prefix (best-effort; no-op in stub mode). */
  abstract deleteByPrefix(prefix: string): Promise<void>;

  abstract getPublicUrl(key: string): string;

  /** Origin under which all stored objects are publicly served (e.g.
   *  `https://cdn.example.com`), or '' when storage isn't configured. Used as the
   *  SSRF allow-origin when re-fetching a stored cover by URL — see
   *  {@link smartFocalFromUrl}. */
  abstract getPublicBaseUrl(): string;
}
