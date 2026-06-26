import { Injectable, Logger } from '@nestjs/common';
import { MapsService } from '../../common/maps/maps.service';
import { ImportAiService } from './import.ai';

export type AddressGeo =
  | { status: 'ok' }
  | { status: 'fixed'; suggestion: string }
  | { status: 'unresolved' };

/** Pooled geocode concurrency — matches MapsService's 8s per-call timeout budget. */
const POOL = 8;

/** Decides whether an address-mode address is resolvable by Google Maps, and if
 *  not, asks ChatGPT (batched) for a geocodable rewrite. Geocode is cache-first
 *  (30-day Redis) so repeat addresses are free. */
@Injectable()
export class AddressGeoService {
  private readonly log = new Logger(AddressGeoService.name);

  constructor(
    private readonly maps: MapsService,
    private readonly ai: ImportAiService,
  ) {}

  /** A fine-grained Google point (not a town centroid) means the carrier can find it. */
  private async eligible(address: string, city: string | null): Promise<boolean> {
    const point = await this.maps.geocode(address, undefined, city ? { locality: city } : undefined);
    return point != null;
  }

  async checkOne(address: string, city: string | null): Promise<AddressGeo> {
    if (!address?.trim()) return { status: 'unresolved' };
    if (await this.eligible(address, city)) return { status: 'ok' };
    const [fix] = await this.ai.repairAddresses([{ index: 0, address, city }]);
    if (fix?.suggestion && (await this.eligible(fix.suggestion, city))) {
      return { status: 'fixed', suggestion: fix.suggestion };
    }
    return { status: 'unresolved' };
  }

  /** Eligibility for many rows with a SINGLE batched AI repair call for the broken ones. */
  async checkMany(
    items: { rowIndex: number; address: string; city: string | null }[],
  ): Promise<Map<number, AddressGeo>> {
    const out = new Map<number, AddressGeo>();
    const broken: { index: number; address: string; city: string | null }[] = [];

    // Pass 1 — pooled eligibility.
    const queue = [...items];
    const elig = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        if (it.address?.trim() && (await this.eligible(it.address, it.city))) out.set(it.rowIndex, { status: 'ok' });
        else broken.push({ index: it.rowIndex, address: it.address ?? '', city: it.city });
      }
    };
    await Promise.all(Array.from({ length: POOL }, elig));
    if (!broken.length) return out;

    // Pass 2 — ONE AI repair call for every broken address.
    const fixes = await this.ai.repairAddresses(broken);
    const fixByIndex = new Map(fixes.map((f) => [f.index, f.suggestion]));

    // Pass 3 — pooled re-geocode of the candidates.
    const bq = [...broken];
    const verify = async () => {
      for (let b = bq.shift(); b; b = bq.shift()) {
        const sug = fixByIndex.get(b.index);
        if (sug && (await this.eligible(sug, b.city))) out.set(b.index, { status: 'fixed', suggestion: sug });
        else out.set(b.index, { status: 'unresolved' });
      }
    };
    await Promise.all(Array.from({ length: POOL }, verify));
    return out;
  }
}
