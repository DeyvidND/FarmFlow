import { PartialType } from '@nestjs/swagger';
import { CreateFarmerDto } from './create-farmer.dto';

// All CreateFarmerDto fields become optional here.
export class UpdateFarmerDto extends PartialType(CreateFarmerDto) {}
