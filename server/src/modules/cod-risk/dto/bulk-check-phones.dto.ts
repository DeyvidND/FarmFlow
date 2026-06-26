import { IsArray, IsString, ArrayMaxSize, ArrayMinSize } from 'class-validator';

export class BulkCheckPhonesDto {
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @ArrayMaxSize(500)
  phones!: string[];
}
