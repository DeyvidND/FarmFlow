'use client';

import { useState } from 'react';
import { Mail, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ApiError, listSubscribers, sendBroadcast, type Subscriber } from '@/lib/api-client';
import { usePaginatedList } from '@/hooks/use-paginated-list';
import type { Paginated } from '@/lib/types';

const field =
  'rounded-sm border border-ff-border bg-ff-surface-2 px-3 py-2.5 text-[14.5px] text-ff-ink outline-none placeholder:text-ff-muted-2 focus:border-ff-green-500 w-full';
const labelCls = 'flex flex-col gap-1.5 text-[12.5px] font-bold text-ff-ink-2';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');

function shortDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('bg-BG', { day: 'numeric', month: 'short', year: 'numeric' });
}

interface Props {
  initial: Paginated<Subscriber>;
  activeCount: number;
  total: number;
}

export function NewsletterClient({ initial, activeCount, total }: Props) {
  const { items: subscribers, loadMore, hasMore, loading } = usePaginatedList<Subscriber>(
    initial,
    listSubscribers,
  );
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [fieldErr, setFieldErr] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [sending, setSending] = useState(false);

  function handleSend() {
    if (!subject.trim() || !body.trim()) {
      setFieldErr('Попълни темата и съобщението.');
      return;
    }
    setFieldErr('');
    setConfirmOpen(true);
  }

  async function confirmSend() {
    setSending(true);
    try {
      const result = await sendBroadcast({ subject: subject.trim(), body: body.trim() });
      toast.success(`Изпратено до ${result.sent} клиента`);
      setSubject('');
      setBody('');
      setConfirmOpen(false);
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="animate-ff-fade-up">
      {/* Header */}
      <div className="mb-[18px] flex items-center justify-between">
        <p className="text-sm text-ff-muted">
          <span className="font-bold text-ff-ink">{activeCount}</span> активни абонати
        </p>
      </div>

      {/* Compose card */}
      <div className="mb-8 rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm">
        <h2 className="mb-4 text-[16px] font-extrabold">Ново съобщение</h2>
        <div className="flex flex-col gap-3">
          <label className={labelCls}>
            Тема
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Тема на имейла"
              className={field}
            />
          </label>
          <label className={labelCls}>
            Съобщение
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="Текст на съобщението…"
              rows={5}
              className={`${field} resize-y`}
            />
          </label>
          {fieldErr && <p className="text-[13px] font-semibold text-ff-red">{fieldErr}</p>}
          <div className="flex justify-end">
            <Button variant="primary" onClick={handleSend} disabled={sending} className="rounded-sm">
              <Mail size={17} /> Изпрати
            </Button>
          </div>
        </div>
      </div>

      {/* Subscribers table */}
      <h2 className="mb-1 text-[16px] font-extrabold">Абонати</h2>
      {total > 0 && (
        <p className="text-sm text-ff-ink-2 mb-3">
          Показани {subscribers.length} от {total} абоната
        </p>
      )}
      {subscribers.length === 0 ? (
        <div className="mt-10 flex flex-col items-center gap-3 text-center">
          <Users size={40} className="text-ff-muted-2" />
          <p className="text-sm text-ff-muted">Все още няма абонати.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface shadow-ff-sm">
          <table className="w-full text-[14px]">
            <thead>
              <tr className="border-b border-ff-border bg-ff-surface-2 text-[12px] font-bold uppercase tracking-wide text-ff-muted">
                <th className="px-4 py-3 text-left">Имейл</th>
                <th className="px-4 py-3 text-left">Дата на регистрация</th>
              </tr>
            </thead>
            <tbody>
              {subscribers.map((s, i) => (
                <tr
                  key={s.id}
                  style={{ animation: `ff-fade-up .35s ease ${i * 0.02}s both` }}
                  className="border-b border-ff-border last:border-0 hover:bg-ff-green-50/40"
                >
                  <td className="px-4 py-3 font-semibold text-ff-ink">{s.email}</td>
                  <td className="px-4 py-3 text-ff-muted">{shortDate(s.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {hasMore && (
        <div className="mt-5 flex flex-col items-center gap-2">
          <button
            onClick={loadMore}
            disabled={loading}
            className="rounded-xl border border-ff-border bg-ff-surface px-5 py-2.5 text-[14px] font-bold text-ff-ink-2 shadow-ff-sm hover:bg-ff-surface-2 disabled:opacity-60"
          >
            {loading ? 'Зареждане…' : 'Зареди още'}
          </button>
          <p className="text-[12px] text-ff-muted">{subscribers.length} / {total}</p>
        </div>
      )}
      {!hasMore && total > 0 && (
        <p className="text-sm text-center text-ff-ink-2 py-4">Всички {total} абоната са заредени.</p>
      )}

      {/* Confirm dialog */}
      {confirmOpen && (
        <div
          className="animate-ff-fade fixed inset-0 z-[80] grid place-items-center bg-black/40 p-4"
          onClick={() => !sending && setConfirmOpen(false)}
        >
          <div
            className="animate-ff-pop w-[400px] max-w-full rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-2 text-[18px] font-extrabold">Изпрати имейл</h2>
            <p className="mb-5 text-[14.5px] text-ff-ink-2">
              Изпрати до{' '}
              <span className="font-bold text-ff-ink">{activeCount}</span>{' '}
              {activeCount === 1 ? 'клиент' : 'клиента'}?
            </p>
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                type="button"
                onClick={() => setConfirmOpen(false)}
                disabled={sending}
                className="rounded-sm"
              >
                Откажи
              </Button>
              <Button
                variant="primary"
                type="button"
                onClick={confirmSend}
                disabled={sending}
                className="rounded-sm"
              >
                {sending ? 'Изпращане…' : 'Изпрати'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
