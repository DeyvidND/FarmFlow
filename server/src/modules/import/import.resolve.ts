import { Injectable } from '@nestjs/common';
import { EcontService } from '../econt/econt.service';
import { SpeedyService } from '../speedy/speedy.service';
import type { NormalizedRow } from './import.types';

export interface PickResult<T> {
  chosen: T | null;
  ambiguous: boolean;
  candidates: T[];
}

/** Choose the best location match: exact name wins; a single prefix match auto-picks;
 *  several prefix matches with no exact → ambiguous (surface candidates in the editor). */
export function pickBest<T>(list: T[], query: string, name: (x: T) => string): PickResult<T> {
  const q = query.toLowerCase().trim();
  if (!q || !list.length) return { chosen: null, ambiguous: false, candidates: [] };
  const exact = list.find((x) => name(x).toLowerCase().trim() === q);
  if (exact) return { chosen: exact, ambiguous: false, candidates: [] };
  const prefix = list.filter((x) => name(x).toLowerCase().trim().startsWith(q));
  if (prefix.length === 1) return { chosen: prefix[0], ambiguous: false, candidates: [] };
  if (prefix.length > 1) return { chosen: null, ambiguous: true, candidates: prefix.slice(0, 10) };
  return { chosen: null, ambiguous: false, candidates: [] };
}

/** Find by case-insensitive substring; first hit or null. */
export function matchByName<T>(list: T[], query: string, name: (x: T) => string): T | null {
  const q = query.toLowerCase().trim();
  return list.find((x) => name(x).toLowerCase().includes(q)) ?? null;
}

/** What resolution produced for one row: refs to stamp + a status hint. */
export interface ResolveResult {
  refs: Record<string, unknown>;
  ambiguous: boolean;
  unresolved: string | null; // field name that couldn't be resolved, or null
}

@Injectable()
export class ImportResolveService {
  constructor(
    private readonly econt: EcontService,
    private readonly speedy: SpeedyService,
  ) {}

  /** Resolve a row's human-typed location into carrier ids/codes. Never throws.
   *  `cache` is an optional per-batch memo so the tenant's settings are read once for
   *  the whole import instead of on every row's carrier lookup (see loadStored). */
  async resolve(tenantId: string, row: NormalizedRow, cache?: Map<string, unknown>): Promise<ResolveResult> {
    try {
      return row.carrier === 'speedy'
        ? await this.resolveSpeedy(tenantId, row, cache)
        : await this.resolveEcont(tenantId, row, cache);
    } catch {
      // A location-lookup outage shouldn't block the import; leave it unresolved.
      return { refs: {}, ambiguous: false, unresolved: row.deliveryMode === 'office' ? 'office' : 'city' };
    }
  }

  private async resolveEcont(tenantId: string, row: NormalizedRow, cache?: Map<string, unknown>): Promise<ResolveResult> {
    // Econt addresses are free-text; only office mode needs a resolved office CODE.
    if (row.deliveryMode !== 'office' || !row.office) return { refs: {}, ambiguous: false, unresolved: null };
    // If the cell already looks like an office code, pass it through.
    if (/^\d{3,}$/.test(row.office)) return { refs: { econtOfficeCode: row.office }, ambiguous: false, unresolved: null };
    const cities = await this.econt.searchCities(tenantId, row.city ?? row.office, cache);
    const cityId = cities[0]?.id;
    if (!cityId) return { refs: {}, ambiguous: false, unresolved: 'office' };
    const offices = await this.econt.getOfficesForCity(tenantId, cityId, cache);
    const hit = matchByName(offices, row.office, (o) => o.name);
    if (!hit) return { refs: {}, ambiguous: offices.length > 1, unresolved: 'office' };
    return { refs: { econtOfficeCode: hit.code }, ambiguous: false, unresolved: null };
  }

  private async resolveSpeedy(tenantId: string, row: NormalizedRow, cache?: Map<string, unknown>): Promise<ResolveResult> {
    if (!row.city) return { refs: {}, ambiguous: false, unresolved: 'city' };
    const sites = await this.speedy.searchSites(tenantId, row.city, cache);
    const site = pickBest(sites, row.city, (s) => s.name);
    if (!site.chosen) {
      return { refs: { siteCandidates: site.candidates }, ambiguous: site.ambiguous, unresolved: 'city' };
    }
    const siteId = site.chosen.id;
    if (row.deliveryMode === 'office') {
      const offices = await this.speedy.getOffices(tenantId, siteId, cache);
      const office = row.office ? matchByName(offices, row.office, (o) => o.name) : null;
      if (!office) return { refs: { siteId }, ambiguous: offices.length > 1, unresolved: 'office' };
      return { refs: { siteId, officeId: office.id }, ambiguous: false, unresolved: null };
    }
    // address mode: best-effort street resolution
    const refs: Record<string, unknown> = { siteId };
    if (row.address) {
      const streets = await this.speedy.getStreets(tenantId, siteId, row.address, cache);
      const street = pickBest(streets, row.address, (s) => s.name);
      if (street.chosen) refs.streetId = street.chosen.id;
    }
    return { refs, ambiguous: false, unresolved: null };
  }
}
