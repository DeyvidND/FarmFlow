// packages/help-ui/src/AskAiBox.tsx
'use client';
import { useState } from 'react';
import { Sparkles } from 'lucide-react';

export function AskAiBox({ onAsk }: { onAsk: (question: string) => Promise<string> }) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const q = question.trim();
    if (!q || loading) return;
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
      <div className="mt-2.5 flex gap-2">
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
          placeholder="Напиши въпроса си…"
          aria-label="Въпрос към AI помощника"
          className="w-full rounded-lg border border-ff-border bg-ff-surface-2 px-3 py-2 text-[13px] text-ff-ink outline-none"
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
      {answer && <p className="mt-3 rounded-lg bg-ff-green-50 p-3 text-[13px] leading-relaxed text-ff-ink-2">{answer}</p>}
      {error && <p className="mt-3 text-[12.5px] text-ff-red">{error}</p>}
    </div>
  );
}
