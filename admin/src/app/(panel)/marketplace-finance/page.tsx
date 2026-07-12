import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { MarketplaceFinanceClient } from '@/components/marketplace-finance-client';
import type { MarketplaceBrand } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getBrands(): Promise<MarketplaceBrand[]> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return [];
  const res = await fetch(`${API_BASE}/platform/marketplace/brands`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  }).catch(() => null);
  if (!res || !res.ok) return [];
  return res.json().catch(() => []);
}

export default async function MarketplaceFinancePage() {
  const brands = await getBrands();
  return <MarketplaceFinanceClient initialBrands={brands} />;
}
