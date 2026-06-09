import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { FeaturesPanel, type FeatureFlags } from '@/components/panels/features-panel';

export const dynamic = 'force-dynamic';

async function load(): Promise<FeatureFlags> {
  const fallback: FeatureFlags = {
    multiFarmer: false,
    multiSubcat: false,
    articlesEnabled: true,
    reviewsEnabled: true,
  };
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return fallback;
  const res = await fetch(`${API_BASE}/tenants/me`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return fallback;
  const t = await res.json();
  return {
    multiFarmer: !!t.multiFarmer,
    multiSubcat: !!t.multiSubcat,
    articlesEnabled: t.articlesEnabled ?? true,
    reviewsEnabled: t.reviewsEnabled ?? true,
  };
}

export default async function FeaturesPage() {
  const initial = await load();
  return <FeaturesPanel initial={initial} />;
}
