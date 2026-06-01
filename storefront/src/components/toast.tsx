'use client';

/**
 * Toast system replacing the template's `flyToast` / `window.FFtoast`. A bottom-
 * center pill with a check icon, auto-dismissing after 2.4s. `toast(msg)` is a
 * plain function callable from anywhere (event handlers, api catch blocks);
 * `<Toaster/>` renders the live pills and lives once in the root layout.
 */
import { useEffect } from 'react';
import { create } from 'zustand';
import { Check } from './icons';

interface ToastItem {
  id: number;
  message: string;
}

interface ToastState {
  toasts: ToastItem[];
  push: (message: string) => void;
  dismiss: (id: number) => void;
}

let seq = 0;

const useToastStore = create<ToastState>((set) => ({
  toasts: [],
  push: (message) =>
    set((s) => ({ toasts: [...s.toasts, { id: ++seq, message }] })),
  dismiss: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Fire a toast from anywhere. */
export function toast(message: string) {
  useToastStore.getState().push(message);
}

const TOAST_MS = 2400;

const pillStyle: React.CSSProperties = {
  background: 'var(--primary)',
  color: '#fff',
  padding: '14px 22px',
  borderRadius: 999,
  fontWeight: 600,
  fontSize: 15,
  boxShadow: '0 16px 40px -10px rgba(0,0,0,.35)',
  display: 'flex',
  gap: 10,
  alignItems: 'center',
  maxWidth: '90vw',
  pointerEvents: 'auto',
};

function Pill({ item }: { item: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  useEffect(() => {
    const t = setTimeout(() => dismiss(item.id), TOAST_MS);
    return () => clearTimeout(t);
  }, [item.id, dismiss]);
  return (
    <div style={pillStyle} className="fade-in" role="status">
      <Check style={{ width: 18, height: 18 }} />
      <span>{item.message}</span>
    </div>
  );
}

export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        alignItems: 'center',
        pointerEvents: 'none',
      }}
    >
      {toasts.map((t) => (
        <Pill key={t.id} item={t} />
      ))}
    </div>
  );
}
