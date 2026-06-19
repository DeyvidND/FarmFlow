'use client';

import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRole } from '@/components/layout/role-context';
import { ConfigurationsCard, type ConfigKey } from '@/components/settings/configurations-card';
import { PasswordCard } from '@/components/settings/password-card';
import { NavVisibilityCard } from '@/components/settings/nav-visibility-card';
import { LandingCard } from '@/components/settings/landing-card';
import { MerchandisingCard } from '@/components/settings/merchandising-card';
import {
  SetupSection,
  DeliverySection,
  SlotsSection,
  FeaturesSection,
  MarketingSection,
} from '@/components/settings/config-sections';

type Section = 'configurations' | 'password' | 'nav';

const CONFIG_KEYS: ConfigKey[] = [
  'setup',
  'delivery',
  'slots',
  'features',
  'merchandising',
  'landing',
  'marketing',
];

const SECTIONS: { id: Section; label: string }[] = [
  { id: 'configurations', label: 'Конфигурации' },
  { id: 'password', label: 'Смяна на парола' },
  { id: 'nav', label: 'Странична навигация' },
];

function ConfigSection({ view }: { view: ConfigKey }) {
  switch (view) {
    case 'setup':
      return <SetupSection />;
    case 'delivery':
      return <DeliverySection />;
    case 'slots':
      return <SlotsSection />;
    case 'features':
      return <FeaturesSection />;
    case 'merchandising':
      return <MerchandisingCard />;
    case 'landing':
      return <LandingCard />;
    case 'marketing':
      return <MarketingSection />;
  }
}

export default function SettingsPage() {
  const role = useRole();
  // A producer sub-account has none of the shop-wide config (the server
  // default-denies every config write) and their sidebar is the fixed FARMER_NAV
  // (nav customization has no effect), so both those tabs are dead ends for them —
  // collapse Настройки to just the password change.
  const isFarmer = role === 'farmer';

  const router = useRouter();
  const searchParams = useSearchParams();
  const configParam = searchParams.get('config');

  const [section, setSection] = useState<Section>('configurations');
  // Which configuration screen is open inline (null = the Конфигурации hub).
  const [configView, setConfigView] = useState<ConfigKey | null>(null);

  // Deep-link support: /settings?config=slots opens that config screen INLINE
  // (keeping the Settings shell + „Назад към Конфигурации" back button) instead
  // of bouncing to the standalone /slots route with no way back. Re-runs when the
  // param changes so cross-links between config screens work too.
  useEffect(() => {
    if (configParam && (CONFIG_KEYS as string[]).includes(configParam)) {
      setSection('configurations');
      setConfigView(configParam as ConfigKey);
    }
  }, [configParam]);

  const go = (id: Section) => {
    setSection(id);
    setConfigView(null); // leaving/entering a tab always returns to the hub
    if (configParam) router.replace('/settings'); // drop a stale ?config=
  };

  const backToHub = () => {
    setConfigView(null);
    if (configParam) router.replace('/settings'); // keep URL in sync with the hub
  };

  if (isFarmer) {
    return (
      <div>
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Настройки</h1>
        <p className="mb-6 text-[13.5px] text-ff-muted">Смени паролата за достъп до панела.</p>
        <PasswordCard />
      </div>
    );
  }

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
              onClick={() => go(s.id)}
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
            key={`${section}:${configView ?? ''}`}
            className="animate-[ff-slide-in-right_0.26s_cubic-bezier(.32,.72,0,1)]"
          >
            {section === 'configurations' &&
              (configView ? (
                <div>
                  <button
                    type="button"
                    onClick={backToHub}
                    className="mb-5 inline-flex items-center gap-1.5 rounded-lg border border-ff-border bg-ff-surface px-3 py-2 text-[13px] font-bold text-ff-ink-2 transition hover:border-ff-green-500 hover:bg-ff-green-50 hover:text-ff-green-800"
                  >
                    <ArrowLeft size={16} />
                    Назад към Конфигурации
                  </button>
                  <ConfigSection view={configView} />
                </div>
              ) : (
                <ConfigurationsCard onOpen={setConfigView} />
              ))}
            {section === 'password' && <PasswordCard />}
            {section === 'nav' && <NavVisibilityCard />}
          </div>
        </div>
      </div>
    </div>
  );
}
