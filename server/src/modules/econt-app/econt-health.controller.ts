import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { ApiTags } from '@nestjs/swagger';

// Liveness probe for the standalone delivery app's Docker healthcheck (GET /health).
// Unguarded in practice: the global TenantRolesGuard + MustChangePasswordGuard only
// enforce when a Bearer token is present, and the probe sends none → both return
// true. @SkipThrottle keeps the 30s polling out of the rate-limit budget. Mirrors
// the main API's AppController liveness route (this module doesn't mount that
// controller, so the standalone app needs its own).
@ApiTags('health')
@Controller('health')
export class EcontHealthController {
  @Get()
  @SkipThrottle()
  health(): { status: 'ok'; timestamp: string } {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }
}
