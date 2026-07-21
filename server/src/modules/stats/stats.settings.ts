/** Таван на информационната комисионна: 50%. По-високо е почти сигурно
 *  сгрешено въвеждане (напр. 10000 вместо 1000), а не реална уговорка. */
export const MAX_COMMISSION_BPS = 5000;

/** Пътят в `tenants.settings`, по който се пише процентът. Ползва се и от
 *  `jsonbDeepMerge` при запис, за да не се разминат ключовете. */
export const INFO_COMMISSION_PATH = ['stats', 'infoCommissionBps'] as const;

/**
 * Информационната комисионна в базисни точки (1000 = 10%), прочетена от
 * `tenants.settings`. Всяко нещо, което не е крайно число — липсваща настройка,
 * стар низ, повреден blob — дава 0: статистиката показва само доставката,
 * вместо да гръмне с NaN през целия екран.
 */
export function readInfoCommissionBps(settings: unknown): number {
  if (!settings || typeof settings !== 'object') return 0;
  const stats = (settings as Record<string, unknown>).stats;
  if (!stats || typeof stats !== 'object') return 0;
  const raw = (stats as Record<string, unknown>).infoCommissionBps;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
  if (raw <= 0) return 0;
  return Math.min(MAX_COMMISSION_BPS, Math.round(raw));
}
