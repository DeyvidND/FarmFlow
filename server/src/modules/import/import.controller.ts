import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
  UploadedFile, UseInterceptors, ParseUUIDPipe, BadRequestException,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentTenant } from '../../common/decorators/current-tenant.decorator';
import { ActivationGuard } from '../econt-app/activation.guard';
import { ImportService } from './import.service';
import { ImportSettingsDto } from './dto/import-settings.dto';
import { PatchRowDto } from './dto/patch-row.dto';

@UseGuards(JwtAuthGuard)
@Controller('import')
export class ImportController {
  constructor(private readonly svc: ImportService) {}

  // Validating an upload calls OpenAI + courier lookups → throttle, but no activation
  // gate (it's pre-purchase, like the cheapest-quote feature).
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('batches')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  create(
    @CurrentTenant() t: string,
    @UploadedFile() file: Express.Multer.File,
    @Body() settings: ImportSettingsDto,
  ) {
    if (!file) throw new BadRequestException('Липсва файл');
    return this.svc.createBatch(t, file, settings);
  }

  @Get('batches/:id')
  get(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getBatch(t, id);
  }

  @Patch('batches/:id/rows/:rowId')
  patchRow(
    @CurrentTenant() t: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
    @Body() patch: PatchRowDto,
  ) {
    return this.svc.patchRow(t, id, rowId, patch);
  }

  @Delete('batches/:id/rows/:rowId')
  deleteRow(
    @CurrentTenant() t: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('rowId', ParseUUIDPipe) rowId: string,
  ) {
    return this.svc.deleteRow(t, id, rowId);
  }

  // Creating real shipments is the paid action → activation-gated, like per-carrier create.
  @UseGuards(ActivationGuard)
  @Post('batches/:id/commit')
  commit(@CurrentTenant() t: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.commit(t, id);
  }
}
