'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { listSlots } from '@/lib/api-client';
import { hhmm, relDayLabel, todayIso } from '@/lib/utils';
import type { Order, Slot, UpdateOrderInput } from '@/lib/types';

/** Local editable draft of an order. Delivery method is fixed; its values
 *  (address/note/office) + slot (when applicable) + contact + notes are here. */
interface Draft {
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  notes: string;
  deliveryAddress: string;
  deliveryNote: string;
  econtOffice: string;
  slotId: string | null;
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
    deliveryAddress: order.deliveryAddress ?? '',
    deliveryNote: order.deliveryNote ?? '',
    econtOffice: order.econtOffice ?? '',
    slotId: order.slotId ?? null,
  });

  const usesSlot = order.deliveryType === 'address';
  const [slots, setSlots] = useState<Slot[]>([]);
  useEffect(() => {
    if (!usesSlot) return;
    const today = todayIso();
    const to = new Date();
    to.setDate(to.getDate() + 14);
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    listSlots(today, iso(to))
      .then((all) =>
        // Free slots only (booked < capacity), never today (local Sofia time,
        // not UTC), plus keep the order's own current slot so it stays
        // selectable even if now full by itself.
        setSlots(all.filter((s) => s.date !== today && (s.booked < s.capacity || s.id === order.slotId))),
      )
      .catch(() => setSlots([]));
  }, [usesSlot, order.slotId]);

  const phoneValid = draft.customerPhone.trim().length > 0;

  function submit() {
    if (!phoneValid) return;
    const patch: UpdateOrderInput = {
      customerName: draft.customerName.trim(),
      customerPhone: draft.customerPhone.trim(),
      customerEmail: draft.customerEmail.trim() || null,
      notes: draft.notes.trim() || null,
    };
    if (order.deliveryType === 'address' || order.deliveryType === 'econt_address' || order.deliveryType === 'courier') {
      patch.deliveryAddress = draft.deliveryAddress.trim();
      patch.deliveryNote = draft.deliveryNote.trim() || null;
    }
    if (order.deliveryType === 'econt') patch.econtOffice = draft.econtOffice.trim();
    if (usesSlot) patch.slotId = draft.slotId;
    onSave(patch);
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

        <div className="mb-2.5 text-[13px] font-bold text-ff-muted">ДОСТАВКА</div>
        <div className="mb-5 flex flex-col gap-3">
          {(order.deliveryType === 'address' ||
            order.deliveryType === 'econt_address' ||
            order.deliveryType === 'courier') && (
            <>
              <Field label="Адрес" value={draft.deliveryAddress} onChange={(v) => setDraft((d) => ({ ...d, deliveryAddress: v }))} />
              <Field label="Бл./вх./ет./ап." value={draft.deliveryNote} onChange={(v) => setDraft((d) => ({ ...d, deliveryNote: v }))} />
            </>
          )}
          {order.deliveryType === 'econt' && (
            <Field label="Еконт офис" value={draft.econtOffice} onChange={(v) => setDraft((d) => ({ ...d, econtOffice: v }))} />
          )}
          {order.deliveryType === 'pickup' && (
            <div className="text-sm font-semibold text-ff-ink-2">Вземане от място</div>
          )}
          {usesSlot && (
            <label className="block">
              <span className="text-xs font-semibold text-ff-muted">Ден и час</span>
              <select
                value={draft.slotId ?? ''}
                onChange={(e) => setDraft((d) => ({ ...d, slotId: e.target.value || null }))}
                className="mt-1 w-full rounded-sm border border-ff-border bg-ff-surface-2 px-2.5 py-2 text-sm font-semibold text-ff-ink outline-none focus:border-ff-green-500"
              >
                <option value="">Без час</option>
                {slots.map((s) => (
                  <option key={s.id} value={s.id}>
                    {relDayLabel(s.date)} · {hhmm(s.timeFrom)} – {hhmm(s.timeTo)}
                  </option>
                ))}
              </select>
            </label>
          )}
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
