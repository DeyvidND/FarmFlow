// packages/help-ui/src/FaqAccordion.tsx
import type { FaqEntry } from '@fermeribg/help-content';

export function FaqAccordion({ entries }: { entries: FaqEntry[] }) {
  if (entries.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-ff-border bg-ff-surface-2 p-4 text-center text-[13px] text-ff-muted">
        Нищо не съвпада с търсенето. Пробвай друга дума или питай AI помощника по-долу.
      </p>
    );
  }
  return (
    <div className="rounded-xl border border-ff-border bg-ff-surface-2 px-4">
      {entries.map((e) => (
        <details key={e.id} className="group border-b border-ff-border-2 py-1 last:border-0">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2.5 text-[13.5px] font-bold text-ff-ink [&::-webkit-details-marker]:hidden">
            {e.question}
            <span className="shrink-0 text-ff-muted transition-transform group-open:rotate-180">⌄</span>
          </summary>
          <p className="pb-3 text-[13px] leading-relaxed text-ff-ink-2">{e.answer}</p>
        </details>
      ))}
    </div>
  );
}
