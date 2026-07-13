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

/**
 * The party to print on a protocol: the confirmed legal identity when it carries
 * a name, otherwise a bare `{ name }` built from the entity's plain display name
 * (farmers.name / tenants.name) so a protocol still prints — signed with just Име
 * и Фамилия — for a farmer or operator who hasn't filled legal data yet. Throws
 * only when there is no name anywhere (unreachable in practice — every farmer and
 * tenant has a display name).
 */
export function resolveParty(
  legal: LegalIdentity | null | undefined,
  fallbackName: string | null | undefined,
  who: string,
): LegalIdentity {
  if (legal && legal.name && legal.name.trim()) return legal;
  const name = fallbackName?.trim();
  if (name) return { name };
  throw new BadRequestException(`Липсват данни за ${who}.`);
}
