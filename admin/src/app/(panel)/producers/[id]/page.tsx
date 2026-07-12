import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { ProducerDetail } from '@/components/producer-detail';
import type { FarmerDetail } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getFarmer(id: string): Promise<FarmerDetail | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_BASE}/platform/farmers/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function ProducerDetailPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const farmer = await getFarmer(params.id);
  if (!farmer) notFound();
  return <ProducerDetail farmer={farmer} />;
}
