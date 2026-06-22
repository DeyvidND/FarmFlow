import { Leaf } from 'lucide-react';
import type { ReactNode } from 'react';

// Password fields gain a show/hide eye toggle via the shared TextField.
export { TextField as AuthField } from '@/components/ui/text-field';

function Logo({ size = 52 }: { size?: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center rounded-[14px] bg-ff-green-700 text-[#EAF1E4] shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
      style={{ width: size, height: size }}
    >
      <Leaf size={size * 0.58} strokeWidth={1.9} />
    </div>
  );
}

/** Centered 420px auth card with the ФермериБГ brand header — from auth.jsx. */
export function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-full flex-col items-center justify-center overflow-y-auto bg-ff-bg px-5 py-10">
      <div
        className="pointer-events-none absolute inset-0 opacity-50"
        style={{ background: 'radial-gradient(60% 50% at 50% -10%, var(--ff-green-50), transparent 70%)' }}
      />

      <div className="animate-ff-fade-up relative w-[420px] max-w-full">
        <div className="mb-[22px] flex flex-col items-center">
          <Logo size={52} />
          <div className="mt-3.5 font-display text-[26px] font-extrabold tracking-[-0.02em]">ФермериБГ</div>
          <div className="mt-0.5 text-sm font-semibold text-ff-muted">Управление на фермата</div>
        </div>

        <div className="rounded-2xl border border-ff-border bg-ff-surface p-[30px] shadow-ff-md">{children}</div>

        {footer && <div className="mt-5 text-center text-[12.5px] text-ff-muted-2">{footer}</div>}
      </div>
    </div>
  );
}

/** Nest validation errors arrive as a string[]; 4xx business errors as a string. */
export function firstMessage(m: unknown): string | undefined {
  if (Array.isArray(m)) return typeof m[0] === 'string' ? m[0] : undefined;
  if (typeof m === 'string') return m;
  return undefined;
}
