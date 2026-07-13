import type { LegalDto } from './dto/legal.dto';
import type { LegalIdentity } from '@fermeribg/types';

const trim = (s?: string) => {
  const t = s?.trim();
  return t ? t : undefined;
};

/** Normalizes the incoming DTO and stamps confirmedAt server-side (audit trail) —
 *  never taken from the client, even if a future DTO field happened to carry one. */
export function normalizeLegal(dto: LegalDto): LegalIdentity {
  return {
    kind: dto.kind,
    name: trim(dto.name),
    eik: trim(dto.eik),
    vatNumber: trim(dto.vatNumber),
    address: trim(dto.address),
    regNo: trim(dto.regNo),
    confirmedAt: new Date().toISOString(),
  };
}
