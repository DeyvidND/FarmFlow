'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Order, UpdateOrderInput } from '@/lib/types';

/** Local editable draft of an order. Delivery method is fixed; only its values
 *  (address/note/office) + contact + notes are here. Items/slot added in later
 *  tasks. */
interface Draft {
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  notes: string;
}

function Field({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="block">
      <span className="text-xs font-semibold text-ff-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-sm border border-ff-border bg-ff-surface-2 px-2.5 py-2 text-sm font-semibold text-ff-ink outline-none transition-colors focus:border-ff-green-500"
      />
    </label>
  );
}

export function OrderEditForm({
  order,
  saving,
  onCancel,
  onSave,
}: {
  order: Order;
  saving: boolean;
  onCancel: () => void;
  onSave: (patch: UpdateOrderInput) => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    customerName: order.customerName ?? '',
    customerPhone: order.customerPhone ?? '',
    customerEmail: order.customerEmail ?? '',
    notes: order.notes ?? '',
  });

  const phoneValid = draft.customerPhone.trim().length > 0;

  function submit() {
    if (!phoneValid) return;
    onSave({
      customerName: draft.customerName.trim(),
      customerPhone: draft.customerPhone.trim(),
      customerEmail: draft.customerEmail.trim() || null,
      notes: draft.notes.trim() || null,
    });
  }

  return (
    <>
      <div className="flex-1 overflow-y-auto px-6 py-5">
        <div className="mb-2.5 text-[13px] font-bold text-ff-muted">КЛИЕНТ</div>
        <div className="mb-5 flex flex-col gap-3">
          <Field label="Име" value={draft.customerName} onChange={(v) => setDraft((d) => ({ ...d, customerName: v }))} />
          <Field label="Телефон" value={draft.customerPhone} onChange={(v) => setDraft((d) => ({ ...d, customerPhone: v }))} />
          {!phoneValid && <span className="text-xs font-semibold text-red-600">Телефонът е задължителен</span>}
          <Field label="Имейл" type="email" value={draft.customerEmail} onChange={(v) => setDraft((d) => ({ ...d, customerEmail: v }))} />
        </div>

        <div className="mb-2.5 text-[13px] font-bold text-ff-muted">БЕЛЕЖКА</div>
        <textarea
          value={draft.notes}
          onChange={(e) => setDraft((d) => ({ ...d, notes: e.target.value }))}
          rows={3}
          className="w-full rounded-sm border border-ff-border bg-ff-surface-2 px-2.5 py-2 text-sm text-ff-ink outline-none transition-colors focus:border-ff-green-500"
        />
      </div>

      <div className="flex gap-2.5 border-t border-ff-border-2 px-6 py-5">
        <Button variant="primary" disabled={saving || !phoneValid} onClick={submit} className="flex-1 rounded-sm">
          Запази
        </Button>
        <Button variant="soft" disabled={saving} onClick={onCancel} className="flex-1 rounded-sm">
          Откажи
        </Button>
      </div>
    </>
  );
}
