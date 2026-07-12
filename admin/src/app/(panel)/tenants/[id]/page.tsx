import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { TenantDetailClient } from '@/components/tenant-detail-client';
import type { PlatformTenantDetail } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getDetail(id: string): Promise<PlatformTenantDetail | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_BASE}/platform/tenants/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function TenantDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const detail = await getDetail(params.id);
  if (!detail) notFound();
  return <TenantDetailClient detail={detail} />;
}
