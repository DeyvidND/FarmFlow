'use client';

// Client-only Quill wrapper. Loaded exclusively via next/dynamic(ssr:false) from
// article-body-editor, so the react-quill-new import (which touches `document`)
// never runs on the server. Maps a plain `forwardedRef` prop onto ReactQuill's
// class `ref` so the parent can reach getEditor().

import ReactQuill from 'react-quill-new';
import 'react-quill-new/dist/quill.snow.css';
import type { ComponentProps, Ref } from 'react';

const Quill = ReactQuill.Quill;

// One-time global Quill patches (module scope = runs once on first client import).
const Link = Quill.import('formats/link') as {
  sanitize: (url: string) => string;
};
const origSanitize = Link.sanitize.bind(Link);
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:'];
Link.sanitize = (url: string): string => {
  try {
    const parsed = new URL(url, window.location.href);
    return SAFE_PROTOCOLS.includes(parsed.protocol) ? origSanitize(url) : 'about:blank';
  } catch {
    return 'about:blank';
  }
};

// Alignment as an inline style (text-align) instead of ql-align-* classes, so the
// stored HTML renders on the storefronts with no Quill CSS dependency.
const AlignStyle = Quill.import('attributors/style/align');
Quill.register(AlignStyle as never, true);

type Props = ComponentProps<typeof ReactQuill> & { forwardedRef?: Ref<ReactQuill> };

export default function QuillWrapper({ forwardedRef, ...props }: Props) {
  return <ReactQuill ref={forwardedRef} {...props} />;
}
