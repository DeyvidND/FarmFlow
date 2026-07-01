// packages/help-ui/src/HelpTabs.tsx
'use client';
import { useState } from 'react';

type TabKey = 'guide' | 'faq' | 'ai';

const TABS: { key: TabKey; label: string }[] = [
  { key: 'guide', label: 'Ръководство' },
  { key: 'faq', label: 'Често задавани въпроси' },
  { key: 'ai', label: 'Питай AI' },
];

/** Splits a Help page into 3 tabs so the walkthrough, FAQ search, and AI chat
 *  don't blend into one long scroll. Only the active tab's content is rendered
 *  (not CSS-hidden) — cheap, and naturally resets each tab's local state
 *  (FAQ search query, AI question) when the user navigates away and back. */
export function HelpTabs({
  guide,
  faq,
  ai,
}: {
  guide: React.ReactNode;
  faq: React.ReactNode;
  ai: React.ReactNode;
}) {
  const [active, setActive] = useState<TabKey>('guide');
  const panels: Record<TabKey, React.ReactNode> = { guide, faq, ai };

  return (
    <div>
      <div className="flex gap-1 border-b border-ff-border">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setActive(t.key)}
            className={`relative px-4 py-2.5 text-[13.5px] font-bold transition-colors ${
              active === t.key ? 'text-ff-green-800' : 'text-ff-muted hover:text-ff-ink-2'
            }`}
          >
            {t.label}
            {active === t.key && <span className="absolute inset-x-0 -bottom-px h-[2px] rounded-full bg-ff-green-700" />}
          </button>
        ))}
      </div>
      <div className="pt-5">{panels[active]}</div>
    </div>
  );
}
