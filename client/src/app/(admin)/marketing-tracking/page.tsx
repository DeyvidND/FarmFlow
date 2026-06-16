import { MarketingSection } from '@/components/settings/config-sections';

// Standalone route kept for deep links; the UI lives in the shared section so
// it can also render inline under Настройки → Конфигурации.
export default function MarketingTrackingPage() {
  return <MarketingSection />;
}
