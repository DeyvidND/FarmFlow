'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { ConfigurationsCard } from '@/components/settings/configurations-card';
import { PasswordCard } from '@/components/settings/password-card';
import { NavVisibilityCard } from '@/components/settings/nav-visibility-card';
import { LandingCard } from '@/components/settings/landing-card';
import { MerchandisingCard } from '@/components/settings/merchandising-card';

type Section = 'configurations' | 'password' | 'nav' | 'landing' | 'merchandising';

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'configurations', label: 'Конфигурации' },
  { id: 'password', label: 'Смяна на парола' },
  { id: 'nav', label: 'Странична навигация' },
  { id: 'landing', label: 'Начална страница' },
  { id: 'merchandising', label: 'Най-продавани и препоръки' },
];

export default function SettingsPage() {
  const [section, setSection] = useState<Section>('configurations');

  return (
    <div>
      <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Настройки</h1>
      <p className="mb-6 text-[13.5px] text-ff-muted">Управлявай настройките на профила си.</p>

      <div className="flex flex-col gap-4 md:flex-row md:items-start md:gap-6">
        {/* Left menu */}
        <nav className="flex flex-row gap-2 overflow-x-auto md:w-[200px] md:shrink-0 md:flex-col md:gap-1">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={cn(
                'whitespace-nowrap rounded-xl border px-4 py-2.5 text-left text-[13.5px] font-bold transition-colors',
                section === s.id
                  ? 'border-ff-green-700 bg-ff-green-50 text-ff-green-800'
                  : 'border-transparent bg-transparent text-ff-ink-2 hover:bg-ff-surface-2',
              )}
            >
              {s.label}
            </button>
          ))}
        </nav>

        {/* Right content */}
        <div className="min-w-0 flex-1">
          <div
            key={section}
            className="animate-[ff-slide-in-right_0.26s_cubic-bezier(.32,.72,0,1)]"
          >
            {section === 'configurations' && <ConfigurationsCard />}
            {section === 'password' && <PasswordCard />}
            {section === 'nav' && <NavVisibilityCard />}
            {section === 'landing' && <LandingCard />}
            {section === 'merchandising' && <MerchandisingCard />}
          </div>
        </div>
      </div>
    </div>
  );
}
