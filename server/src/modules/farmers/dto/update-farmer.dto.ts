import { PartialType } from '@nestjs/swagger';
import { CreateFarmerDto } from './create-farmer.dto';

// All CreateFarmerDto fields (incl. courierEnabled) become optional here.
export class UpdateFarmerDto extends PartialType(CreateFarmerDto) {}
