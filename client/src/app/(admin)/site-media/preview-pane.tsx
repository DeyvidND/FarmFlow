'use client';

import { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import { RefreshCw } from 'lucide-react';

export interface PreviewHandle {
  /** Navigate (if needed) to the page for `route` and scroll/outline `section`. */
  focusSection: (route: string, section: string) => void;
  /** Reload the current preview (after a save). */
  reload: () => void;
}

function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

export const PreviewPane = forwardRef<PreviewHandle, { siteUrl: string }>(function PreviewPane(
  { siteUrl },
  ref,
) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [route, setRoute] = useState('/');
  const pending = useRef<string | null>(null);
  const origin = originOf(siteUrl);

  function src(r: string) {
    return `${siteUrl.replace(/\/$/, '')}${r}?preview=1`;
  }

  function postScroll(section: string) {
    if (!origin) return;
    iframeRef.current?.contentWindow?.postMessage({ type: 'ff-preview-scroll', section }, origin);
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.origin !== origin) return;
      if ((e.data || {}).type === 'ff-preview-ready' && pending.current) {
        postScroll(pending.current);
        pending.current = null;
      }
    }
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origin]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useImperativeHandle(ref, () => ({
    focusSection(r, section) {
      if (r !== route) {
        pending.current = section;     // flushed on ff-preview-ready
        setRoute(r);
      } else {
        postScroll(section);
      }
    },
    reload() {
      const f = iframeRef.current;
      if (f) f.src = src(route);
    },
  }), [route, origin]);

  if (!siteUrl) {
    return (
      <div className="grid h-full place-items-center rounded-2xl border border-dashed border-ff-border bg-ff-surface p-6 text-center text-[13.5px] text-ff-muted">
        {/* eslint-disable-next-line react/no-unescaped-entities */}
        Въведи „Адрес на сайта", за да виждаш преглед на живо.
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-ff-border bg-ff-surface shadow-ff-sm">
      <div className="flex items-center justify-between gap-2 border-b border-ff-border px-3 py-2">
        <span className="truncate text-[12px] text-ff-muted">{src(route)}</span>
        <button type="button" onClick={() => iframeRef.current && (iframeRef.current.src = src(route))}
          title="Опресни" className="p-1 text-ff-muted hover:text-ff-ink"><RefreshCw size={14} /></button>
      </div>
      <iframe ref={iframeRef} src={src(route)} title="Преглед на сайта"
        className="h-full w-full flex-1 bg-white" />
    </div>
  );
});
