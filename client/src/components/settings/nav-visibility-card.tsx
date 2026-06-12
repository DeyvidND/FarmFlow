'use client';

/**
 * Settings → side-nav customization. Lets the farmer hide menu items (or whole
 * sections) they don't use, so the sidebar isn't over-stacked. Sections can also
 * be reordered — drag the grip handle or use ↑↓ arrows. Stored per-user in
 * users.hiddenNav via PATCH /auth/me/nav (hidden keys + a "navorder:…" entry).
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LayoutDashboard, ChevronUp, ChevronDown, GripVertical } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SaveBar } from '@/components/panels/panel-ui';
import { NAV_GROUPS, HOME, navGroupKey, parseNavOrder, encodeNavOrder } from '@/components/layout/sidebar';
import { ApiError, getMe, updateHiddenNav } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const sortedKey = (s: Set<string>) => [...s].sort().join('|');

export function NavVisibilityCard() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<Set<string>>(new Set());
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());
  const [savedNavOrder, setSavedNavOrder] = React.useState<string[]>([]);
  const [navOrder, setNavOrder] = React.useState<string[]>([]);
  const [dragId, setDragId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let active = true;
    getMe()
      .then((me) => {
        if (!active) return;
        const { hidden: initHidden, navOrder: initOrder } = parseNavOrder(me.hiddenNav ?? []);
        const init = new Set(initHidden);
        setSaved(init);
        setHidden(new Set(init));
        setSavedNavOrder(initOrder);
        setNavOrder(initOrder);
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  const dirty =
    sortedKey(hidden) !== sortedKey(saved) || navOrder.join('|') !== savedNavOrder.join('|');

  const setVisible = (key: string, visible: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(key);
      else next.add(key);
      return next;
    });

  const moveSection = (title: string, dir: -1 | 1) =>
    setNavOrder((prev) => {
      const idx = prev.indexOf(title);
      if (idx < 0) return prev;
      const swap = idx + dir;
      if (swap < 0 || swap >= prev.length) return prev;
      const next = [...prev];
      [next[idx], next[swap]] = [next[swap], next[idx]];
      return next;
    });

  const dropOnto = (targetTitle: string) => {
    if (!dragId || dragId === targetTitle) return;
    setNavOrder((prev) => {
      const from = prev.indexOf(dragId);
      const to = prev.indexOf(targetTitle);
      if (from === -1 || to === -1) return prev;
      const next = [...prev];
      next.splice(from, 1);
      next.splice(to, 0, dragId);
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const defaultOrder = NAV_GROUPS.map((g) => g.title).join('|');
      const isDefault = navOrder.join('|') === defaultOrder;
      const arr = [...hidden, ...(isDefault ? [] : [encodeNavOrder(navOrder)])];
      await updateHiddenNav(arr);
      setSaved(new Set([...hidden]));
      setSavedNavOrder([...navOrder]);
      router.refresh();
      toast.success('Менюто е обновено');
    } catch (e) {
      toast.error(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className={cn('rounded-2xl border border-ff-border bg-ff-surface p-6 shadow-ff-sm', dirty && 'mb-16')}>
      <h2 className="text-[16px] font-extrabold">Странична навигация</h2>
      <p className="mt-1 text-[13px] leading-snug text-ff-muted">
        Скрий менютата, които не ползваш, за да не е претрупана лявата лента. Влачи секциите или
        използвай ↑↓, за да промениш реда им.
      </p>

      {loading ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {/* Табло — pinned, not hideable or reorderable */}
          <div className="flex items-center gap-3 rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3 opacity-90">
            <span className="w-[18px] shrink-0" />
            <span className="grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[10px] border border-ff-border-2 bg-ff-surface text-ff-muted">
              <LayoutDashboard size={20} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-[14.5px] font-extrabold text-ff-ink">{HOME.label}</div>
              <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">
                {HOME.desc} Винаги видимо.
              </div>
            </div>
            <ToggleSwitch checked disabled onChange={() => {}} />
          </div>

          {navOrder.map((groupTitle, idx) => {
            const group = NAV_GROUPS.find((g) => g.title === groupTitle);
            if (!group) return null;
            const groupKey = navGroupKey(group.title);
            const groupVisible = !hidden.has(groupKey);
            const dragging = dragId === group.title;
            return (
              <div
                key={group.title}
                draggable
                onDragStart={() => setDragId(group.title)}
                onDragEnd={() => setDragId(null)}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => { e.preventDefault(); dropOnto(group.title); setDragId(null); }}
                className={cn(
                  'overflow-hidden rounded-xl border border-ff-border bg-ff-surface-2 transition-opacity',
                  dragging && 'opacity-40',
                )}
              >
                {/* Section header */}
                <div className="flex items-center gap-2 border-b border-ff-border py-3 pl-3 pr-[15px]">
                  {/* Grip */}
                  <span className="cursor-grab text-ff-muted-2 active:cursor-grabbing" aria-hidden>
                    <GripVertical size={18} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-ff-muted-2">
                      Секция
                    </div>
                    <div className="text-[14.5px] font-extrabold text-ff-ink">{group.title}</div>
                    {group.desc && (
                      <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">{group.desc}</div>
                    )}
                  </div>
                  {/* ↑↓ reorder arrows */}
                  <div className="flex flex-col">
                    <button
                      type="button"
                      onClick={() => moveSection(group.title, -1)}
                      disabled={idx === 0}
                      aria-label="Премести нагоре"
                      className="grid h-6 w-6 place-items-center rounded text-ff-muted transition-colors hover:bg-ff-surface hover:text-ff-ink disabled:pointer-events-none disabled:opacity-25"
                    >
                      <ChevronUp size={15} />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSection(group.title, 1)}
                      disabled={idx === navOrder.length - 1}
                      aria-label="Премести надолу"
                      className="grid h-6 w-6 place-items-center rounded text-ff-muted transition-colors hover:bg-ff-surface hover:text-ff-ink disabled:pointer-events-none disabled:opacity-25"
                    >
                      <ChevronDown size={15} />
                    </button>
                  </div>
                  <ToggleSwitch
                    checked={groupVisible}
                    onChange={(v) => setVisible(groupKey, v)}
                  />
                </div>

                {/* Per-item toggles */}
                <div className="flex flex-col">
                  {group.items.map((item) => {
                    const itemVisible = !hidden.has(item.href);
                    return (
                      <div
                        key={item.href}
                        className={cn(
                          'flex items-center gap-3 px-[15px] py-2.5 transition-opacity',
                          !groupVisible && 'opacity-45',
                        )}
                      >
                        <span className="grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[9px] border border-ff-border-2 bg-ff-surface text-ff-muted">
                          <item.Icon size={18} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-[14px] font-bold text-ff-ink">{item.label}</div>
                          {item.desc && (
                            <div className="mt-0.5 text-[12px] leading-snug text-ff-muted">{item.desc}</div>
                          )}
                        </div>
                        <ToggleSwitch
                          small
                          checked={groupVisible && itemVisible}
                          disabled={!groupVisible}
                          onChange={(v) => setVisible(item.href, v)}
                        />
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {dirty && (
        <SaveBar
          saving={saving}
          onSave={save}
          onDiscard={() => {
            setHidden(new Set(saved));
            setNavOrder([...savedNavOrder]);
          }}
        />
      )}
    </section>
  );
}
