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
}
