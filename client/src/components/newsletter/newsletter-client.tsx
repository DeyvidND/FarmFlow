'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Mail, Users, Plus, Trash2, Send, FileEdit } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { moneyFromStotinki } from '@/lib/utils';
import {
  ApiError, createCampaign, deleteCampaign, listSubscribers,
  type Subscriber, type NewsletterCampaign,
} from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';
import type { Paginated } from '@/lib/types';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('bg-BG', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface Props {
  initialCampaigns: NewsletterCampaign[];
  initialSubscribers: Paginated<Subscriber>;
  activeCount: number;
  total: number;
}

export function NewsletterClient({ initialCampaigns, initialSubscribers, activeCount, total }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<'campaigns' | 'subscribers'>('campaigns');
  const [campaigns, setCampaigns] = useState(initialCampaigns);
  const [creating, setCreating] = useState(false);

  async function createBlank() {
    setCreating(true);
    try {
      const c = await createCampaign({ subject: '', blocks: [{ type: 'text', html: '' }] });
      router.push(`/newsletters/${c.id}`);
    } catch (e) {
      toast.error(errMsg(e));
      setCreating(false);
    }
  }

  async function remove(id: string) {
    try {
      await deleteCampaign(id);
      setCampaigns((cs) => cs.filter((c) => c.id !== id));
      toast.success('Изтрито');
    } catch (e) {
      toast.error(errMsg(e));
    }
  }

  return (
    <div className="animate-ff-fade-up">
      {/* header */}
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-1 rounded-lg bg-ff-surface-2 p-1">
          <TabBtn active={tab === 'campaigns'} onClick={() => setTab('campaigns')}>Бюлетини</TabBtn>
          <TabBtn active={tab === 'subscribers'} onClick={() => setTab('subscribers')}>
            Абонати <span className="text-ff-muted">({activeCount})</span>
          </TabBtn>
        </div>
        {tab === 'campaigns' && (
          <Button variant="primary" onClick={createBlank} disabled={creating} className="rounded-sm">
            <Plus size={17} /> {creating ? 'Създаване…' : 'Ново съобщение'}
          </Button>
        )}
      </div>

      {tab === 'campaigns' ? (
        <CampaignsTable campaigns={campaigns} onOpen={(id) => router.push(`/newsletters/${id}`)} onDelete={remove} />
      ) : (
        <SubscribersTable initial={initialSubscribers} total={total} />
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3.5 py-1.5 text-[13.5px] font-bold transition ${
        active ? 'bg-ff-surface text-ff-ink shadow-ff-sm' : 'text-ff-muted hover:text-ff-ink-2'
      }`}
    >
      {children}
    </button>
  );
}

function CampaignsTable({
  campaigns, onOpen, onDelete,
}: { campaigns: NewsletterCampaign[]; onOpen: (id: string) => void; onDelete: (id: string) => void }) {
  if (campaigns.length === 0) {
    return (
      <div className="mt-10 flex flex-col items-center gap-3 text-center">
        <Mail size={40} className="text-ff-muted-2" />
        <p className="text-sm text-ff-muted">Още няма бюлетини. Създай първото си съобщение.</p>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <table className="w-full text-[14px]">
        <thead>
          <tr className="border-b border-ff-border bg-ff-surface-2 text-[12px] font-bold uppercase tracking-wide text-ff-muted">
            <th className="px-4 py-3 text-left">Тема</th>
            <th className="px-4 py-3 text-left">Статус</th>
            <th className="px-4 py-3 text-left">Дата</th>
            <th className="px-4 py-3 text-right">Получатели</th>
            <th className="px-4 py-3 text-right">Цена</th>
            <th className="px-4 py-3"></th>
          </tr>
        </thead>
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} className="border-b border-ff-border last:border-0 hover:bg-ff-green-50/40">
              <td className="cursor-pointer px-4 py-3 font-semibold text-ff-ink" onClick={() => onOpen(c.id)}>
                {c.subject || <span className="text-ff-muted">(без тема)</span>}
              </td>
              <td className="px-4 py-3">
                {c.status === 'sent' ? (
                  <span className="inline-flex items-center gap-1 rounded-sm bg-ff-green-100 px-2 py-0.5 text-[12px] font-bold text-ff-green-800"><Send size={12} /> Изпратен</span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded-sm bg-ff-surface-2 px-2 py-0.5 text-[12px] font-bold text-ff-muted"><FileEdit size={12} /> Чернова</span>
                )}
              </td>
              <td className="px-4 py-3 text-ff-muted">{shortDate(c.sentAt ?? c.updatedAt)}</td>
              <td className="px-4 py-3 text-right ff-fig">{c.recipientCount ?? '—'}</td>
              <td className="px-4 py-3 text-right ff-fig">{c.priceStotinki != null ? moneyFromStotinki(c.priceStotinki) : '—'}</td>
              <td className="px-4 py-3 text-right">
                {c.status === 'draft' && (
                  <button onClick={() => onDelete(c.id)} title="Изтрий" className="text-ff-muted hover:text-ff-red">
                    <Trash2 size={16} />
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SubscribersTable({ initial, total }: { initial: Paginated<Subscriber>; total: number }) {
  const { items: subscribers, loadMore, hasMore, loading } = usePaginatedList<Subscriber>(initial, listSubscribers);
  if (subscribers.length === 0) {
    return (
      <div className="mt-10 flex flex-col items-center gap-3 text-center">
        <Users size={40} className="text-ff-muted-2" />
        <p className="text-sm text-ff-muted">Все още няма абонати.</p>
      </div>
    );
  }
  return (
    <>
      {total > 0 && <p className="mb-3 text-sm text-ff-ink-2">Показани {subscribers.length} от {total} абоната</p>}
      <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
        <table className="w-full text-[14px]">
          <thead>
            <tr className="border-b border-ff-border bg-ff-surface-2 text-[12px] font-bold uppercase tracking-wide text-ff-muted">
              <th className="px-4 py-3 text-left">Имейл</th>
              <th className="px-4 py-3 text-left">Дата на регистрация</th>
            </tr>
          </thead>
          <tbody>
            {subscribers.map((s) => (
              <tr key={s.id} className="border-b border-ff-border last:border-0 hover:bg-ff-green-50/40">
                <td className="px-4 py-3 font-semibold text-ff-ink">{s.email}</td>
                <td className="px-4 py-3 text-ff-muted">{shortDate(s.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasMore && (
        <div className="mt-5 flex justify-center">
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
          >
            {loading ? 'Зареждане…' : 'Зареди още'}
          </button>
        </div>
      )}
    </>
  );
}
