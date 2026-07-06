/** Inline jargon explainer — dotted underline + native title tooltip on hover/focus.
 *  No Tooltip component exists in this codebase yet, so this stays a plain
 *  `title` attribute rather than pulling in a Radix dependency for one word. */
export function TermHint({ term, hint }: { term: string; hint: string }) {
  return (
    <span
      title={hint}
      tabIndex={0}
      className="cursor-help underline decoration-dotted decoration-ff-muted-2 underline-offset-2"
    >
      {term}
    </span>
  );
}
