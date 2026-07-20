import { moneyFromStotinki } from '@/lib/utils';
import type { TodaySummary, TodayPipeline } from '@/lib/types';

/** Sub-line builders + predicates for the „Днес" tiles. Kept pure (no JSX) so
 *  they unit-test under vitest's node env — the .tsx tiles just render them. */

export function prepSubLine(prep: TodaySummary['prep']): string {
  return `${prep.fulfilled}/${prep.ordersToPrep} готови`;
}

export function routeSubLine(route: TodaySummary['route']): string {
  return `${route.delivered}/${route.stops} доставени · ${route.couriers} куриер(и)`;
}

export function protocolsSubLine(protocols: TodaySummary['protocols']): string {
  return `${protocols.signed}/${protocols.total} подписани`;
}

export function codSubLine(cod: TodaySummary['cod']): string {
  return `${moneyFromStotinki(cod.toCollectStotinki)} за събиране · ${moneyFromStotinki(cod.collectedStotinki)} събрани`;
}

/** The inline «Потвърди всички» action only makes sense when there are «Нови». */
export function showConfirmAll(pipeline: TodayPipeline): boolean {
  return pipeline.new > 0;
}

export function confirmAllLabel(pipeline: TodayPipeline): string {
  return `Потвърди всички (${pipeline.new})`;
}

/** Each tile deep-links to its own screen — the biz detail lives there. */
export const tileHref = {
  prep: '/prep',
  route: '/route',
  protocols: '/protocols',
  cod: '/payments',
} as const;
