import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { StorageService } from '../storage.service';
import { assertContentMatchesMime } from '../magic-mime';

@Injectable()
export class R2StorageProvider extends StorageService {
  private readonly logger = new Logger(R2StorageProvider.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;
  private readonly publicUrl: string;
  private readonly stubMode: boolean;

  constructor(private readonly config: ConfigService) {
    super();
    const accountId = this.config.get<string>('R2_ACCOUNT_ID', '');
    const accessKeyId = this.config.get<string>('R2_ACCESS_KEY_ID', '');
    const secretAccessKey = this.config.get<string>('R2_SECRET_ACCESS_KEY', '');
    this.bucket = this.config.get<string>('R2_BUCKET_NAME', '');
    // Trim trailing slashes so getPublicUrl never produces `host//key`.
    this.publicUrl = this.config.get<string>('R2_PUBLIC_URL', '').replace(/\/+$/, '');

    // Live only when the full credential set is present. A partial config (e.g.
    // account id but no keys) would otherwise build a client that throws on the
    // first upload — instead, fall back to stub mode and say why, loudly.
    const complete = !!(accountId && accessKeyId && secretAccessKey && this.bucket);
    if (!complete) {
      this.stubMode = true;
      this.client = null;
      if (accountId || accessKeyId || secretAccessKey || this.bucket) {
        this.logger.error(
          'R2 is partially configured (need R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, ' +
            'R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME together) — staying in stub mode. Uploads return fake URLs.',
        );
      } else {
        this.logger.warn(
          'R2 not configured — StorageService running in dev no-op stub mode. Uploads will return fake URLs.',
        );
      }
      return;
    }
    if (!this.publicUrl) {
      this.logger.warn(
        'R2 is configured but R2_PUBLIC_URL is empty — stored image URLs will be relative and unservable.',
      );
    }

    this.stubMode = false;
    this.client = new S3Client({
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      region: 'auto',
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async upload(
    file: Buffer,
    key: string,
    contentType: string,
  ): Promise<{ key: string; url: string }> {
    // The bytes must really be the declared media type — the route's
    // FileTypeValidator only checks the spoofable Content-Type header. This blocks
    // storing arbitrary content under an image MIME on the public bucket.
    assertContentMatchesMime(file, contentType);

    if (this.stubMode || !this.client) {
      this.logger.warn(`[stub] upload skipped for key=${key}`);
      return { key, url: this.getPublicUrl(key) };
    }
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: file,
        ContentType: contentType,
        // Every key embeds a randomUUID, so a given URL's bytes never change —
        // a replaced image gets a fresh URL (and the old object is deleted).
        // That makes the object safely immutable: let the browser + Cloudflare
        // cache it for a year. Invalidation is automatic (change ⇒ new URL),
        // while the URL-bearing API payloads are busted in Redis on write.
        CacheControl: 'public, max-age=31536000, immutable',
      }),
    );
    return { key, url: this.getPublicUrl(key) };
  }

  async delete(key: string): Promise<void> {
    if (this.stubMode || !this.client) {
      this.logger.warn(`[stub] delete skipped for key=${key}`);
      return;
    }
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async deleteByPrefix(prefix: string): Promise<void> {
    if (this.stubMode || !this.client) {
      this.logger.warn(`[stub] deleteByPrefix skipped for prefix=${prefix}`);
      return;
    }
    let token: string | undefined;
    do {
      const listed = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (listed.Contents ?? [])
        .map((o) => ({ Key: o.Key! }))
        .filter((k) => k.Key);
      if (keys.length) {
        // DeleteObjects caps at 1000 keys; ListObjectsV2 already pages at 1000.
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: keys, Quiet: true } }),
        );
      }
      token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (token);
  }

  getPublicUrl(key: string): string {
    return `${this.publicUrl}/${key.replace(/^\/+/, '')}`;
  }

  getPublicBaseUrl(): string {
    return this.publicUrl;
  }
}
