/** The legal identity a producer submits for their handover protocols. */
export type LegalKind = '' | 'individual' | 'sole_trader' | 'company';

export type LegalFormFields = {
  kind: LegalKind;
  name: string;
  eik: string;
  vatNumber: string;
  address: string;
  regNo: string;
};

export type LegalPayload = {
  kind?: Exclude<LegalKind, ''>;
  name?: string;
  eik?: string;
  vatNumber?: string;
  address?: string;
  regNo?: string;
};

const clean = (s: string) => s.trim() || undefined;

/**
 * Build the `legal` block to PATCH, sending ONLY the identifier that applies to
 * the selected kind.
 *
 * Why this is a function and not three lines inline: the ЕИК/Рег.№ input is a
 * single field backed by two pieces of state. Typing before choosing a kind
 * lands in `eik` (the default), and switching to „Физическо лице" and retyping
 * leaves the same digits in BOTH. The check screen's `idLine` prefers `eik`, so
 * a физическо лице would print „ЕИК 1234567" — an identifier they do not have,
 * on the document a police officer reads. Filtering by kind here makes that
 * state unreachable regardless of what the form's local state accumulated.
 *
 * An unset kind ('') is treated as non-individual, which matches what the form
 * shows the user: the field is labelled „ЕИК / БУЛСТАТ" until they choose.
 */
export function buildLegalPayload(f: LegalFormFields): LegalPayload {
  const isIndividual = f.kind === 'individual';
  return {
    kind: f.kind || undefined,
    name: clean(f.name),
    address: clean(f.address),
    eik: isIndividual ? undefined : clean(f.eik),
    vatNumber: isIndividual ? undefined : clean(f.vatNumber),
    regNo: isIndividual ? clean(f.regNo) : undefined,
  };
}
