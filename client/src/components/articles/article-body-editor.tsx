'use client';

import { useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import type ReactQuill from 'react-quill-new';
import { toast } from 'sonner';
import { uploadArticleInlineImage } from '@/lib/api-client';

// Quill touches `window`/`document` → never SSR it. The wrapper carries the
// react-quill-new import + CSS + Quill patches; this file stays SSR-safe.
const QuillWrapper = dynamic(() => import('./quill-wrapper'), {
  ssr: false,
  loading: () => <div className="article-editor-quill-skeleton" />,
});

const TOOLBAR = [
  ['bold', 'italic', 'underline', 'strike'],
  [{ header: 2 }, { header: 3 }],
  [{ color: [] }],
  [{ align: '' }, { align: 'center' }, { align: 'right' }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['link', 'image'],
  ['clean'],
];

const FORMATS = [
  'bold', 'italic', 'underline', 'strike',
  'header', 'color', 'align', 'list', 'link', 'image',
];

export function ArticleBodyEditor({
  articleId,
  value,
  onChange,
}: {
  articleId: string;
  value: string;
  onChange: (html: string) => void;
}) {
  const quillRef = useRef<ReactQuill | null>(null);

  const imageHandler = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/jpeg,image/png,image/webp';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        const { url } = await uploadArticleInlineImage(articleId, file);
        const editor = quillRef.current?.getEditor();
        if (!editor) return;
        const range = editor.getSelection(true);
        const index = range ? range.index : editor.getLength();
        editor.insertEmbed(index, 'image', url, 'user');
        editor.setSelection(index + 1, 0);
      } catch {
        toast.error('Неуспешно качване на снимка');
      }
    };
    input.click();
  }, [articleId]);

  const modules = useMemo(
    () => ({ toolbar: { container: TOOLBAR, handlers: { image: imageHandler } } }),
    [imageHandler],
  );

  return (
    <div className="article-editor-quill">
      <QuillWrapper
        forwardedRef={quillRef}
        theme="snow"
        value={value}
        onChange={onChange}
        modules={modules}
        formats={FORMATS}
        placeholder="Текст на статията…"
      />
    </div>
  );
}
