import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsObject, IsString, MaxLength, ValidateNested } from 'class-validator';

export class FaqItemDto {
  @IsString() @MaxLength(300) q: string;
  @IsString() @MaxLength(4000) a: string;
}

export class SiteEditContentDto {
  @IsObject() copy: Record<string, string>;
  @IsArray() @ArrayMaxSize(50) @ValidateNested({ each: true }) @Type(() => FaqItemDto) faq: FaqItemDto[];
}
