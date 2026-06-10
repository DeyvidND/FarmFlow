import { BadRequestException } from '@nestjs/common';

/**
 * Sniff a buffer's true media type from its leading magic bytes — limited to the
 * formats FarmFlow accepts (jpeg/png/webp images, mp4/webm video). Returns the
 * canonical MIME, or null if the signature is unrecognised.
 */
export function sniffMime(buf: Buffer): string | null {
  if (!buf || buf.length < 12) return null;

  // JPEG — FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';

  // PNG — 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WEBP — "RIFF"...."WEBP" (check before any other RIFF container)
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }

  // ICO — 00 00 01 00 (Windows icon; favicon)
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return 'image/x-icon';
  }

  // WEBM / Matroska — 1A 45 DF A3
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) {
    return 'video/webm';
  }

  // MP4 / ISO-BMFF — bytes 4..7 == "ftyp" (covers isom/mp42/M4V…)
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';

  return null;
}

/**
 * Guard: the uploaded bytes must actually be the media type the request claims.
 * The `Content-Type` multer reports is derived from the client's request header
 * and is fully spoofable — without this, an authenticated tenant could store
 * arbitrary content (HTML/SVG/JS polyglots, malware) under an image MIME on the
 * public R2 bucket. Throws `BadRequestException` on any mismatch.
 */
export function assertContentMatchesMime(buf: Buffer, contentType: string): void {
  const declared = contentType.split(';')[0].trim().toLowerCase();
  const detected = sniffMime(buf);
  if (detected !== declared) {
    throw new BadRequestException(
      'Съдържанието на файла не съответства на обявения тип. Качи валиден файл.',
    );
  }
}
