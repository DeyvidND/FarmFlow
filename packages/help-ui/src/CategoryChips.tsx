// packages/help-ui/src/CategoryChips.tsx
'use client';
import type { CategoryDef } from '@fermeribg/help-content';

export function CategoryChips({
  categories,
  active,
  onToggle,
}: {
  categories: CategoryDef[];
  active: string[];
  onToggle: (id: string) => void;
}) {
  const chip = (isActive: boolean) =>
    `rounded-full border px-3 py-1.5 text-[12.5px] font-bold transition-colors ${
      isActive
        ? 'border-ff-green-500 bg-ff-green-50 text-ff-green-800'
        : 'border-ff-border bg-ff-surface text-ff-ink-2 hover:bg-ff-surface-2'
    }`;
  return (
    <div className="flex flex-wrap gap-2">
      {/* "Всички" clears by re-firing onToggle for each active id — onToggle MUST use React's
          functional setState form (prev => ...), not a closure over the outer `active` array,
          or clearing more than one active category will misbehave. */}
      <button type="button" onClick={() => active.forEach(onToggle)} className={chip(active.length === 0)}>
        Всички
      </button>
      {categories.map((c) => (
        <button key={c.id} type="button" onClick={() => onToggle(c.id)} className={chip(active.includes(c.id))}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
