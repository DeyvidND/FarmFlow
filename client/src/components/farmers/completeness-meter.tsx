import { Check, Circle } from 'lucide-react';

export type CompletenessInput = {
  hasPhoto: boolean;
  hasBio: boolean;
  hasStory: boolean;
  hasProducts: boolean;
  hasAccess: boolean;
  /** Marketplace tenant — adds the legal + payout items. */
  marketplace: boolean;
  hasLegal: boolean;
  hasPayout: boolean;
};

export type CompletenessItem = { key: string; label: string; done: boolean };

/** Which profile items count toward "complete", and whether each is done. Pure so
 *  it's unit-tested directly. Marketplace tenants get 2 extra items (legal, payout). */
export function computeCompleteness(i: CompletenessInput): CompletenessItem[] {
  const items: CompletenessItem[] = [
    { key: 'photo', label: 'Снимка', done: i.hasPhoto },
    { key: 'bio', label: 'Кратко описание', done: i.hasBio },
    { key: 'story', label: 'За фермата', done: i.hasStory },
    { key: 'products', label: 'Свързани продукти', done: i.hasProducts },
    { key: 'access', label: 'Достъп до панела', done: i.hasAccess },
  ];
  if (i.marketplace) {
    items.push({ key: 'legal', label: 'Легални данни', done: i.hasLegal });
    items.push({ key: 'payout', label: 'IBAN за изплащане', done: i.hasPayout });
  }
  return items;
}

export function CompletenessMeter({ items }: { items: CompletenessItem[] }) {
  const done = items.filter((i) => i.done).length;
  const pct = Math.round((done / items.length) * 100);
  return (
    <div className="rounded-xl border border-ff-border-2 bg-ff-surface-2 p-3.5">
      <div className="mb-2 flex items-center justify-between text-[12.5px] font-extrabold text-ff-ink-2">
        <span>Попълненост на профила</span>
        <span>{pct}%</span>
      </div>
      <div className="mb-3 h-2 overflow-hidden rounded-full bg-ff-border">
        <div className="h-full rounded-full bg-ff-green-600 transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="flex flex-wrap gap-x-3 gap-y-1.5">
        {items.map((i) => (
          <li
            key={i.key}
            className={`flex items-center gap-1 text-[12px] font-semibold ${
              i.done ? 'text-ff-green-700' : 'text-ff-muted'
            }`}
          >
            {i.done ? <Check size={13} /> : <Circle size={13} />} {i.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
