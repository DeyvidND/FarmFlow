/**
 * Client mirror of the server's window splitting (slot-rule.ts splitWindow):
 * a delivery window + "колко трае една доставка" → the concrete sub-slots.
 * Drives the rule card's live preview and the per-day override dialog, so what
 * the admin sees is exactly what the server will materialize.
 */
export interface HhmmWindow {
  timeFrom: string; // HH:MM
  timeTo: string; // HH:MM
}

export const toMin = (t: string) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
export const toHhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Full chunks only; window too short for one chunk → the whole window. */
export function splitWindowChunks(win: HhmmWindow, slotMinutes: number): HhmmWindow[] {
  if (!slotMinutes || slotMinutes <= 0) return [{ timeFrom: win.timeFrom, timeTo: win.timeTo }];
  const from = toMin(win.timeFrom);
  const to = toMin(win.timeTo);
  if (to - from < slotMinutes) return [{ timeFrom: win.timeFrom, timeTo: win.timeTo }];
  const out: HhmmWindow[] = [];
  for (let m = from; m + slotMinutes <= to; m += slotMinutes) {
    out.push({ timeFrom: toHhmm(m), timeTo: toHhmm(m + slotMinutes) });
  }
  return out;
}
