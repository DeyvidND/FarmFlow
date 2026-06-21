import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { DemoRequestService } from './demo-request.service';
import { DemoRequestDto } from './dto/demo-request.dto';

/** Public marketing-site lead intake (request-a-demo). CORS-open `/public/*`. */
@ApiTags('public')
@Controller('public')
export class DemoRequestController {
  constructor(private readonly demoRequest: DemoRequestService) {}

  // Anonymous, email-triggering: throttle hard (3/min/IP).
  @Throttle({ default: { limit: 3, ttl: 60_000 } })
  @Post('demo-request')
  @HttpCode(200)
  submit(@Body() dto: DemoRequestDto) {
    return this.demoRequest.submit(dto);
  }
}
