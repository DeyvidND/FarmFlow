export abstract class StorageService {
  abstract upload(
    file: Buffer,
    key: string,
    contentType: string,
  ): Promise<{ key: string; url: string }>;

  abstract delete(key: string): Promise<void>;

  abstract getPublicUrl(key: string): string;
}
