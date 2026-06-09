'use client';

/**
 * Settings → side-nav customization. Lets the farmer hide menu items (or whole
 * sections) they don't use, so the sidebar isn't over-stacked. Purely cosmetic:
 * hidden screens stay reachable by URL and can be turned back on here at any time.
 * Stored per-user in users.hiddenNav via PATCH /auth/me/nav.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LayoutDashboard } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { SaveBar } from '@/components/panels/panel-ui';
import { NAV_GROUPS, HOME, navGroupKey } from '@/components/layout/sidebar';
import { ApiError, getMe, updateHiddenNav } from '@/lib/api-client';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Възникна грешка');
const sortedKey = (s: Set<string>) => [...s].sort().join('|');

export function NavVisibilityCard() {
  const router = useRouter();
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState<Set<string>>(new Set());
  const [hidden, setHidden] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    let active = true;
    getMe()
      .then((me) => {
        if (!active) return;
        const init = new Set(me.hiddenNav ?? []);
        setSaved(init);
        setHidden(new Set(init));
      })
      .catch(() => active && toast.error('Неуспешно зареждане на настройките'))
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const dirty = sortedKey(hidden) !== sortedKey(saved);

  // visible=true → ensure the key is NOT in the hidden set; false → add it.
  const setVisible = (key: string, visible: boolean) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(key);
      else next.add(key);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const arr = [...hidden];
      await updateHiddenNav(arr);
      setSaved(new Set(arr));
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
        Скрий менютата, които не ползваш, за да не е претрупана лявата лента. Скритите екрани
        остават достъпни и можеш да ги върнеш оттук по всяко време.
      </p>

      {loading ? (
        <div className="mt-5 text-[13.5px] text-ff-muted">Зареждане…</div>
      ) : (
        <div className="mt-5 flex flex-col gap-4">
          {/* Табло is pinned — it's the landing page, so it can't be hidden. */}
          <div className="flex items-center gap-3 rounded-xl border border-ff-border bg-ff-surface-2 px-[15px] py-3 opacity-90">
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

          {NAV_GROUPS.map((group) => {
            const groupKey = navGroupKey(group.title);
            const groupVisible = !hidden.has(groupKey);
            return (
              <div
                key={group.title}
                className="overflow-hidden rounded-xl border border-ff-border bg-ff-surface-2"
              >
                {/* Section row — toggling off hides the whole group at once. */}
                <div className="flex items-center gap-3 border-b border-ff-border px-[15px] py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-[11px] font-extrabold uppercase tracking-[0.06em] text-ff-muted-2">
                      Секция
                    </div>
                    <div className="text-[14.5px] font-extrabold text-ff-ink">{group.title}</div>
                    {group.desc && (
                      <div className="mt-0.5 text-[12.5px] leading-snug text-ff-muted">{group.desc}</div>
                    )}
                  </div>
                  <ToggleSwitch
                    checked={groupVisible}
                    onChange={(v) => setVisible(groupKey, v)}
                  />
                </div>

                {/* Per-item toggles — disabled (and shown off) while the section is hidden. */}
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

      {dirty && <SaveBar saving={saving} onSave={save} onDiscard={() => setHidden(new Set(saved))} />}
    </section>
  );
}
