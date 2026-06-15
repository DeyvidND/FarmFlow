import { SiteEditor } from './site-editor';

export default function SiteEditorPage() {
  return (
    <div className="max-w-[1400px]">
      <div className="mb-6">
        <h1 className="mb-1 text-[22px] font-extrabold tracking-[-0.01em]">Промени сайта</h1>
        <p className="text-[13.5px] text-ff-muted">
          Смени текстовете и снимките на сайта. Фокусирай поле, за да видиш къде е на живо вдясно.
        </p>
      </div>
      <SiteEditor />
    </div>
  );
}
