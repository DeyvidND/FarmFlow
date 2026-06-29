import { cookies } from 'next/headers';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { AuditClient } from '@/components/audit-client';
import type { Paginated, AuditLog } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

const EMPTY: Paginated<AuditLog> = { items: [], nextCursor: null };

async function getAudit(): Promise<Paginated<AuditLog>> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return EMPTY;
  const res = await fetch(`${API_BASE}/platform/audit?limit=50`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return EMPTY;
  return res.json();
}

export default async function AuditPage() {
  const initial = await getAudit();
  return <AuditClient initial={initial} />;
}
