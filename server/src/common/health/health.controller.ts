import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';
import { HealthService } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  // Distinct from the liveness GET /health on AppController: this one verifies
  // DB + Redis and returns 503 when either is unreachable.
  @Get('ready')
  @SkipThrottle()
  async ready(): Promise<{ status: 'ok' }> {
    try {
      return await this.health.ready();
    } catch {
      throw new ServiceUnavailableException('not ready');
    }
  }
}
