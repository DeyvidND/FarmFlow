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

/** Everything an operator can actually edit. `confirmedAt` is deliberately absent:
 *  it is a server-written audit stamp, not a field, so it must never count as a change. */
const EDITABLE: (keyof LegalPayload)[] = ['kind', 'name', 'address', 'eik', 'vatNumber', 'regNo'];

/** The shape the server hands back (LegalIdentity), structurally — kept local so this
 *  module stays free of a `@/lib/types` import. */
type SavedLegal = Partial<Record<keyof LegalPayload, string>>;

/**
 * Has the operator changed the legal identity relative to what is stored?
 *
 * Both sides go through `buildLegalPayload` first, then are compared FIELD BY FIELD.
 * Both halves of that matter:
 *
 * - Field-by-field, not `JSON.stringify(a) === JSON.stringify(b)`. Stringify preserves
 *   insertion order, and the two objects were built by different literals whose key
 *   orders disagreed (`…address, eik…` vs `…eik, …, address`). An UNTOUCHED company
 *   identity carrying both an address and an ЕИК therefore compared unequal, so the
 *   SaveBar — which renders only while dirty — never went away after a successful
 *   save. The data was written; the card just never admitted it.
 * - Normalising the saved side through the same builder collapses the server's `""`
 *   and the form's untouched blank onto the same `undefined`, and applies the same
 *   kind filter, so leftover state in a hidden input (an `eik` still populated under
 *   „Физическо лице") isn't reported as an edit when saving would not change the row.
 */
export function isLegalDirty(form: LegalFormFields, saved: SavedLegal | null | undefined): boolean {
  if (!saved) return false; // not loaded yet — nothing to diff against
  const next = buildLegalPayload(form);
  const current = buildLegalPayload({
    kind: (saved.kind as LegalKind) ?? '',
    name: saved.name ?? '',
    eik: saved.eik ?? '',
    vatNumber: saved.vatNumber ?? '',
    address: saved.address ?? '',
    regNo: saved.regNo ?? '',
  });
  return EDITABLE.some((k) => next[k] !== current[k]);
}
