import { IsIn } from 'class-validator';

export class UpdateTenantStatusDto {
  @IsIn(['active', 'inactive'])
  status!: 'active' | 'inactive';
}
