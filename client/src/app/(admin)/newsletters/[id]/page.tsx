import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { API_BASE, SESSION_COOKIE } from '@/lib/session';
import { CampaignEditor } from '@/components/newsletter/campaign-editor';
import type { NewsletterCampaign } from '@/lib/api-client';

export const dynamic = 'force-dynamic';

async function getCampaign(id: string): Promise<NewsletterCampaign | null> {
  const token = cookies().get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const res = await fetch(`${API_BASE}/newsletter/campaigns/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: 'no-store',
  });
  if (!res.ok) return null;
  return res.json();
}

export default async function CampaignEditorPage({ params }: { params: { id: string } }) {
  const campaign = await getCampaign(params.id);
  if (!campaign) redirect('/newsletters');
  return <CampaignEditor initial={campaign} />;
}
