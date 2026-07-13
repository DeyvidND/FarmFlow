import { BadRequestException } from '@nestjs/common';
import type { LegalIdentity } from '@fermeribg/types';

export type { LegalIdentity };

/** Guard: a protocol party must have at least a legal name. `who` is used in the error. */
export function requireLegal(l: LegalIdentity | null | undefined, who: string): LegalIdentity {
  if (!l || !l.name || !l.name.trim()) {
    throw new BadRequestException(`Липсват легални данни за ${who}.`);
  }
  return l;
}
