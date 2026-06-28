import { Injectable } from '@nestjs/common';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';
import type { CarrierAdapter } from './carrier-adapter';

/**
 * Resolves a carrier name to its {@link CarrierAdapter}. Anything that isn't an
 * explicit 'speedy' falls through to Econt — matching the legacy default (null /
 * 'econt' / unknown → Econt), so existing single-carrier farms are unaffected.
 */
@Injectable()
export class CarrierRegistry {
  constructor(
    private readonly econt: EcontService,
    private readonly speedy: SpeedyService,
  ) {}

  get(carrier: string | null | undefined): CarrierAdapter {
    return carrier === 'speedy' ? this.speedy : this.econt;
  }
}
