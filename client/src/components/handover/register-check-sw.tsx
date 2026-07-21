'use client';

import { useEffect } from 'react';

/**
 * Registers the offline service worker (`public/sw.js`, Task 15) for the
 * roadside „Проверка" check screen, so the page shell can still load with
 * zero signal. Rendered only from `protocols/check/page.tsx` — this screen
 * is the one place offline access actually matters.
 *
 * Best-effort by design: an unsupported browser (no `serviceWorker` in
 * `navigator`, e.g. some in-app webviews) or a failed registration must
 * never break the page — the check view still works online, and falls back
 * to its own IndexedDB cache (`protocol-cache.ts`) when offline even
 * without the worker.
 */
export function RegisterCheckSW() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }, []);
  return null;
}
