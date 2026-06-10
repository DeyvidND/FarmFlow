/** ISO-8601 week number (1..53) for a date, computed in UTC. Week 1 is the week
 *  containing the year's first Thursday. Used to drive the auto-rotate
 *  «Продукт на седмицата» pick deterministically (no cron, no stored state). */
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
