'use client';

import { useCallback, useMemo, useRef } from 'react';
import dynamic from 'next/dynamic';
import type ReactQuill from 'react-quill-new';
import { toast } from 'sonner';
import { uploadCampaignInlineImage } from '@/lib/api-client';

// Reuse the SAME client-only Quill wrapper built for articles (it carries the
// react-quill-new import + CSS + one-time Quill patches). next/dynamic ssr:false
// keeps `document` off the server.
const QuillWrapper = dynamic(() => import('@/components/articles/quill-wrapper'), {
  ssr: false,
  loading: () => <div className="min-h-[110px] rounded-sm bg-ff-surface-2" />,
});

const TOOLBAR = [
  ['bold', 'italic', 'underline'],
  [{ header: 2 }, { header: 3 }],
  [{ color: [] }],
  [{ align: '' }, { align: 'center' }, { align: 'right' }],
  [{ list: 'ordered' }, { list: 'bullet' }],
  ['link', 'image'],
  ['clean'],
];

const FORMATS = ['bold', 'italic', 'underline', 'strike', 'header', 'color', 'align', 'list', 'link', 'image'];

export function QuillBlock({
  campaignId,
  value,
  onChange,
  placeholder,
}: {
  campaignId: string;
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
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
        const { url } = await uploadCampaignInlineImage(campaignId, file);
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
  }, [campaignId]);

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
        placeholder={placeholder ?? 'Текст…'}
      />
    </div>
  );
}
