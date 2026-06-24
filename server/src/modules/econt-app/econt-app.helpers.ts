const CYR_MAP: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
  к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u',
  ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sht', ъ: 'a', ь: 'y', ю: 'yu', я: 'ya',
};

/** Transliterate + kebab-case a farm name into a URL-safe slug stem (no uniqueness). */
export function slugifyFarm(name: string): string {
  const translit = (name ?? '')
    .toLowerCase()
    .split('')
    .map((ch) => CYR_MAP[ch] ?? ch)
    .join('');
  const slug = translit.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `ferma-${Math.abs(hashCode(name ?? ''))}`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

/** Default `tenants.settings` for a standalone Econt account. */
export function econtTenantSettings(): Record<string, unknown> {
  return {
    product: 'econt-standalone',
    econtApp: { active: false },
    delivery: { econt: { mode: 'manual' } },
  };
}

/** Is the tenant's standalone account paid/active? */
export function isEcontAccountActive(settings: unknown): boolean {
  const s = (settings ?? {}) as Record<string, any>;
  return s.econtApp?.active === true;
}

/** Merge the active flag into a settings blob without dropping other keys. */
export function withEcontActive(settings: unknown, active: boolean): Record<string, unknown> {
  const s = (settings ?? {}) as Record<string, any>;
  return { ...s, econtApp: { ...(s.econtApp ?? {}), active } };
}
