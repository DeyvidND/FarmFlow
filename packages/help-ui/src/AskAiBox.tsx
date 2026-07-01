// packages/help-ui/src/AskAiBox.tsx
'use client';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';

export function AskAiBox({ onAsk }: { onAsk: (question: string) => Promise<string> }) {
  const [question, setQuestion] = useState('');
  const [submittedQuestion, setSubmittedQuestion] = useState<string | null>(null);
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const q = question.trim();
    if (!q || loading) return;
    setSubmittedQuestion(q);
    setQuestion('');
    setLoading(true);
    setError(null);
    setAnswer(null);
    try {
      setAnswer(await onAsk(q));
    } catch {
      setError('AI помощникът не е достъпен в момента, виж въпросите по-горе.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-xl border border-ff-border bg-ff-surface p-4 shadow-ff-sm">
      <div className="flex items-center gap-2 text-[13.5px] font-bold text-ff-ink">
        <Sparkles size={17} className="text-ff-green-700" /> Не намери отговор? Питай AI
      </div>

      {submittedQuestion && (
        <div className="mt-3.5 flex flex-col gap-3" aria-live="polite" aria-atomic="true" aria-busy={loading}>
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl rounded-tr-sm bg-ff-green-700 px-3.5 py-2.5 text-[13px] text-white">
              {submittedQuestion}
            </div>
          </div>

          {loading && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-ff-surface-2 px-3.5 py-3">
                <div className="flex gap-1">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ff-muted" />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ff-muted" style={{ animationDelay: '150ms' }} />
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-ff-muted" style={{ animationDelay: '300ms' }} />
                </div>
                <div className="mt-2.5 flex flex-col gap-1.5">
                  <span className="h-3 w-48 animate-pulse rounded bg-ff-border-2" />
                  <span className="h-3 w-40 animate-pulse rounded bg-ff-border-2" />
                  <span className="h-3 w-32 animate-pulse rounded bg-ff-border-2" />
                </div>
              </div>
            </div>
          )}

          {!loading && answer && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm bg-ff-surface-2 px-3.5 py-2.5 text-[13px] leading-relaxed text-ff-ink-2">
                {answer}
              </div>
            </div>
          )}

          {!loading && error && (
            <div className="flex justify-start">
              <div className="max-w-[85%] rounded-2xl rounded-tl-sm border border-ff-red bg-[#FBE9E7] px-3.5 py-2.5 text-[12.5px] text-ff-red">
                {error}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="mt-3.5 flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Напиши въпроса си…"
          aria-label="Въпрос към AI помощника"
          disabled={loading}
          className="w-full rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2 text-[13px] text-ff-ink outline-none disabled:opacity-60"
        />
        <button
          type="button"
          onClick={submit}
          disabled={loading || !question.trim()}
          className="shrink-0 rounded-lg bg-ff-green-700 px-3.5 py-2 text-[12.5px] font-bold text-white disabled:opacity-50"
        >
          {loading ? '…' : 'Питай'}
        </button>
      </div>
    </div>
  );
}
