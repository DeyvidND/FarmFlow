// packages/help-ui/src/HelpSearchBar.tsx
'use client';
import { Search } from 'lucide-react';

export function HelpSearchBar({
  value,
  onChange,
  placeholder = 'Търси въпрос…',
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl border border-ff-border bg-ff-surface px-3.5 py-2.5 shadow-ff-sm">
      <Search size={18} className="shrink-0 text-ff-muted" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-transparent text-[13.5px] text-ff-ink outline-none placeholder:text-ff-muted"
      />
    </div>
  );
}
