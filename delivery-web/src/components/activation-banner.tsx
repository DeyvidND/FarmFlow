'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { getAccountStatus } from '@/lib/api-client';

/**
 * Persistent banner shown across the panel when the delivery account is NOT yet
 * activated (super-admin-controlled). The farmer/admin can't self-fix it — every
 * waybill-creating action 403s until then — so the banner explains the wait and
 * points at Помощ instead of leaving them to hit a cryptic error.
 */
export function ActivationBanner() {
  const [active, setActive] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    getAccountStatus()
      .then((r) => { if (alive) setActive(r.active); })
      .catch(() => { /* never block the panel on a status hiccup */ });
    return () => { alive = false; };
  }, []);

  // Only render once we KNOW it's inactive (null = loading/unknown → stay quiet).
  if (active !== false) return null;

  return (
    <div className="mx-auto flex max-w-[1100px] px-8 pt-5 max-sm:px-4">
      <div className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-[#e7c9a0] bg-ff-amber-softer px-4 py-3">
        <AlertTriangle size={18} className="shrink-0 text-ff-amber-600" />
        <span className="text-[13.5px] font-semibold text-ff-ink-2">
          Услугата „Доставки“ все още не е активирана. Свържи куриерските си акаунти;
          щом платформата я активира, ще можеш да създаваш товарителници.
        </span>
        <Link
          href="/help"
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-ff-amber-600 bg-ff-surface px-3 py-1.5 text-[13px] font-bold text-ff-amber-600 hover:bg-ff-surface-2"
        >
          Научи повече <ArrowRight size={14} />
        </Link>
      </div>
    </div>
  );
}
