import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { StorageService } from '../storage.service';

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
    this.bucket = this.config.get<string>('R2_BUCKET_NAME', '');
    this.publicUrl = this.config.get<string>('R2_PUBLIC_URL', '');

    if (!accountId) {
      this.stubMode = true;
      this.client = null;
      this.logger.warn(
        'R2_ACCOUNT_ID not set — StorageService running in dev no-op stub mode. Uploads will return fake URLs.',
      );
      return;
    }

    this.stubMode = false;
    this.client = new S3Client({
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: true,
      region: 'auto',
      credentials: {
        accessKeyId: this.config.get<string>('R2_ACCESS_KEY_ID', ''),
        secretAccessKey: this.config.get<string>('R2_SECRET_ACCESS_KEY', ''),
      },
    });
  }

  async upload(
    file: Buffer,
    key: string,
    contentType: string,
  ): Promise<{ key: string; url: string }> {
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

  getPublicUrl(key: string): string {
    return `${this.publicUrl}/${key}`;
  }
}
