'use client';

import { useState, type InputHTMLAttributes } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * Labeled text input matching the FarmFlow form style. Password fields get a
 * built-in show/hide eye toggle so the farmer can check what they typed
 * (no more guessing behind the dots).
 */
export function TextField({
  label,
  type,
  ...props
}: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  const [show, setShow] = useState(false);
  const isPw = type === 'password';
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-bold text-ff-ink-2">{label}</span>
      <div className="relative">
        <input
          type={isPw ? (show ? 'text' : 'password') : type}
          className={`w-full rounded-sm border border-ff-border bg-ff-surface-2 px-3.5 py-3 text-[15px] text-ff-ink outline-none transition-colors placeholder:text-ff-muted-2 focus:border-ff-green-500${
            isPw ? ' pr-11' : ''
          }`}
          {...props}
        />
        {isPw && (
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShow((v) => !v)}
            aria-label={show ? 'Скрий паролата' : 'Покажи паролата'}
            className="absolute right-2.5 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-md text-ff-muted hover:text-ff-ink"
          >
            {show ? <EyeOff size={17} /> : <Eye size={17} />}
          </button>
        )}
      </div>
    </label>
  );
}
