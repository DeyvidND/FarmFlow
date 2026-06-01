'use client';

import { useEffect, useState } from 'react';

/**
 * `false` on the server and the first client render, `true` after mount. Use it
 * to gate UI that depends on `localStorage`/`window` (cart count, theme tab,
 * promo dismissal) so SSR and the first client render agree — no hydration
 * mismatch.
 */
export function useHasMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
