'use client';

import { useEffect, useState } from 'react';
import { Plus, Minus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { listSlots, listProducts, listProductVariants } from '@/lib/api-client';
import { hhmm, relDayLabel, todayIso, moneyFromStotinki } from '@/lib/utils';
import type { Order, Slot, UpdateOrderInput, Product, ProductVariant } from '@/lib/types';

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

  // Card-paid orders lock item/total edits (money already captured).
  const itemsLocked = order.paymentStatus === 'paid';

  interface DraftItem {
    productId: string;
    variantId?: string;
    productName: string; // display snapshot for the row
    quantity: number;
    priceStotinki: number; // preview only; server re-prices on save
  }
  const [items, setItems] = useState<DraftItem[]>(
    order.items
      .filter((it): it is typeof it & { productId: string } => it.productId != null)
      .map((it) => ({
        productId: it.productId,
        variantId: it.variantId ?? undefined,
        productName: it.productName ?? '',
        quantity: it.quantity,
        priceStotinki: it.priceStotinki,
      })),
  );

  const cartValid = itemsLocked || items.length > 0;

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
    if (!itemsLocked) {
      // Only send `items` when the cart actually changed — the backend treats
      // any presence of `items` as "replace the whole cart" (re-prices at
      // today's catalog price, re-validates every line is still active), so a
      // pure contact/address/slot/notes edit must never include this key.
      const itemKey = (productId: string, variantId: string | undefined, quantity: number) =>
        `${productId}:${variantId ?? ''}:${quantity}`;
      const originalItems = order.items
        .filter((it): it is typeof it & { productId: string } => it.productId != null)
        .map((it) => itemKey(it.productId, it.variantId ?? undefined, it.quantity))
        .sort()
        .join('|');
      const currentItems = items
        .map((it) => itemKey(it.productId, it.variantId, it.quantity))
        .sort()
        .join('|');
      if (currentItems !== originalItems) {
        patch.items = items.map((it) => ({ productId: it.productId, quantity: it.quantity, ...(it.variantId ? { variantId: it.variantId } : {}) }));
      }
    }
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

        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-[13px] font-bold text-ff-muted">ПРОДУКТИ</span>
          {itemsLocked && <span className="text-xs font-semibold text-ff-muted">Платена поръчка — заключено</span>}
        </div>
        <div className="mb-4 overflow-hidden rounded-xl border border-ff-border-2">
          {items.map((it, i) => (
            <div key={`${it.productId}-${it.variantId ?? ''}-${i}`} className={`flex items-center justify-between gap-2 px-3.5 py-2.5 ${i < items.length - 1 ? 'border-b border-ff-border-2' : ''}`}>
              <span className="flex-1 text-sm font-semibold">{it.productName}</span>
              {itemsLocked ? (
                <span className="text-[13.5px] font-bold text-ff-muted">× {it.quantity}</span>
              ) : (
                <div className="flex items-center gap-1.5">
                  <button aria-label="Намали" onClick={() => setItems((p) => p.map((x, j) => (j === i ? { ...x, quantity: Math.max(1, x.quantity - 1) } : x)))} className="grid h-7 w-7 place-items-center rounded-sm border border-ff-border bg-ff-surface-2">
                    <Minus size={14} />
                  </button>
                  <span className="w-7 text-center text-sm font-bold">{it.quantity}</span>
                  <button aria-label="Увеличи" onClick={() => setItems((p) => p.map((x, j) => (j === i ? { ...x, quantity: x.quantity + 1 } : x)))} className="grid h-7 w-7 place-items-center rounded-sm border border-ff-border bg-ff-surface-2">
                    <Plus size={14} />
                  </button>
                  <button aria-label="Премахни" onClick={() => setItems((p) => p.filter((_, j) => j !== i))} className="grid h-7 w-7 place-items-center rounded-sm border border-ff-border bg-ff-surface-2 text-red-600">
                    <Trash2 size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
        {!itemsLocked && <AddProductRow onAdd={(item) => setItems((p) => [...p, item])} />}
        <div className="mb-5 mt-3 flex items-center justify-between px-1">
          <span className="text-[15px] font-bold">Общо (без доставка)</span>
          <span className="ff-fig text-lg font-extrabold">{moneyFromStotinki(items.reduce((s, x) => s + x.quantity * x.priceStotinki, 0))}</span>
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
        <Button variant="primary" disabled={saving || !phoneValid || !cartValid} onClick={submit} className="flex-1 rounded-sm">
          Запази
        </Button>
        <Button variant="soft" disabled={saving} onClick={onCancel} className="flex-1 rounded-sm">
          Откажи
        </Button>
      </div>
    </>
  );
}

/** Compact "add a product" control: search the catalog, pick a product (+ variant
 *  when it has them), append it as a new order line. Prices are for preview only;
 *  the server re-prices on save. */
function AddProductRow({
  onAdd,
}: {
  onAdd: (item: { productId: string; variantId?: string; productName: string; quantity: number; priceStotinki: number }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [products, setProducts] = useState<Product[]>([]);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Product | null>(null);
  const [variants, setVariants] = useState<ProductVariant[]>([]);
  const [variantId, setVariantId] = useState<string>('');

  useEffect(() => {
    if (open && products.length === 0) listProducts().then((r) => setProducts(r.items)).catch(() => setProducts([]));
  }, [open, products.length]);

  async function choose(p: Product) {
    setPicked(p);
    const vs = await listProductVariants(p.id).catch(() => []);
    setVariants(vs);
    setVariantId('');
  }

  function confirm() {
    if (!picked) return;
    if (variants.length > 0 && !variantId) return; // must pick a variant
    const v = variants.find((x) => x.id === variantId) ?? null;
    onAdd({
      productId: picked.id,
      variantId: v?.id,
      productName: [picked.name, v?.label ?? picked.weight].filter(Boolean).join(' '),
      quantity: 1,
      priceStotinki: v?.priceStotinki ?? picked.priceStotinki,
    });
    setOpen(false);
    setPicked(null);
    setVariants([]);
    setQ('');
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="flex w-full items-center justify-center gap-1.5 rounded-sm border border-dashed border-ff-border py-2 text-[13px] font-bold text-ff-green-700">
        <Plus size={15} /> Добави продукт
      </button>
    );
  }

  const filtered = q ? products.filter((p) => p.name.toLowerCase().includes(q.toLowerCase())) : products;

  return (
    <div className="rounded-sm border border-ff-border bg-ff-surface-2 p-3">
      {!picked ? (
        <>
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Търси продукт…" className="mb-2 w-full rounded-sm border border-ff-border bg-ff-surface px-2.5 py-1.5 text-sm outline-none focus:border-ff-green-500" />
          <div className="max-h-44 overflow-y-auto">
            {filtered.map((p) => (
              <button key={p.id} onClick={() => void choose(p)} className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-ff-surface">
                <span>{p.name}</span>
                <span className="text-ff-muted">{moneyFromStotinki(p.priceStotinki)}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="mb-2 text-sm font-bold">{picked.name}</div>
          {variants.length > 0 && (
            <select value={variantId} onChange={(e) => setVariantId(e.target.value)} className="mb-2 w-full rounded-sm border border-ff-border bg-ff-surface px-2.5 py-1.5 text-sm outline-none focus:border-ff-green-500">
              <option value="">Избери вариант…</option>
              {variants.map((v) => (
                <option key={v.id} value={v.id}>{v.label} · {moneyFromStotinki(v.priceStotinki)}</option>
              ))}
            </select>
          )}
          <div className="flex gap-2">
            <Button variant="primary" onClick={confirm} disabled={variants.length > 0 && !variantId} className="flex-1 rounded-sm py-1.5 text-[13px]">Добави</Button>
            <Button variant="soft" onClick={() => setPicked(null)} className="rounded-sm py-1.5 text-[13px]">Назад</Button>
          </div>
        </>
      )}
    </div>
  );
}
