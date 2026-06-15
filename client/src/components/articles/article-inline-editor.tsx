'use client';

import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { cn } from '@/lib/utils';

// Same client-only Quill wrapper the body editor uses (SSR-safe via dynamic import).
const QuillWrapper = dynamic(() => import('./quill-wrapper'), {
  ssr: false,
  loading: () => <div className="article-inline-quill-skeleton" />,
});

// Lightweight toolbar: text marks only. No alignment, no images, no headings,
// links or colour — matches the "само текст функционалност" brief.
const TOOLBAR = [['bold', 'italic', 'underline', 'strike']];
const FORMATS = ['bold', 'italic', 'underline', 'strike'];

/**
 * Single-line rich field for an article's title / excerpt. Enter is disabled so
 * the editor stays one block; the server flattens whatever HTML it produces into
 * inline-safe markup (sanitizeInlineHtml).
 */
export function ArticleInlineEditor({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const modules = useMemo(
    () => ({
      toolbar: TOOLBAR,
      keyboard: {
        bindings: {
          enter: { key: 'Enter', handler: () => false },
          shiftEnter: { key: 'Enter', shiftKey: true, handler: () => false },
        },
      },
    }),
    [],
  );

  return (
    <div className={cn('article-inline-quill', className)}>
      <QuillWrapper
        theme="snow"
        value={value}
        onChange={onChange}
        modules={modules}
        formats={FORMATS}
        placeholder={placeholder}
      />
    </div>
  );
}
