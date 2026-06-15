import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsObject, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator';

export class FaqItemDto {
  @IsString()
  @MaxLength(300)
  q: string;

  @IsString()
  @MaxLength(4000)
  a: string;
}

export class SiteCopyDto {
  /** slot key → override text. Validated server-side against the catalog (cleanCopy). */
  @IsObject()
  copy: Record<string, string>;

  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => FaqItemDto)
  faq: FaqItemDto[];

  @IsOptional()
  @IsString()
  @MaxLength(300)
  siteUrl?: string;
}
