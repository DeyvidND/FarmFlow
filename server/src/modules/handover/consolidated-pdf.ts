import { A4_LANDSCAPE, MARGIN } from './pdf-kit';
import { columnWidths, type Cell, type Column } from './pdf-table';
import type { ConsolidatedFarmerRow } from './consolidated-protocol.service';
import type { ProtocolItemDto } from './dto/create-protocol.dto';

const itemsLine = (items: ProtocolItemDto[]): string =>
  items.map((it) => `${it.productName}${it.variantLabel ? ' · ' + it.variantLabel : ''} — ${it.quantity}${it.unit ?? ''}`).join('; ');

// Column widths computed from the landscape content width so the total is
// always exact (drawTable throws on a mismatch) regardless of A4_LANDSCAPE's
// literal value — weights, not pixels, are the source of truth.
const FARMER_COL_WEIGHTS = [1, 6, 11, 3, 3];
export const FARMER_COLUMNS: Column[] = (() => {
  const total = A4_LANDSCAPE.w - 2 * MARGIN;
  const [num, name, items, batch, eDoc] = columnWidths(total, FARMER_COL_WEIGHTS);
  return [
    { header: '№', width: num, align: 'right' },
    { header: 'Фермер', width: name },
    { header: 'Продукти и количества', width: items },
    { header: 'Партида', width: batch },
    { header: 'Е-док.', width: eDoc },
  ];
})();

/** Pure: farmer rows → drawTable cells. 1-based row numbers in column 0 are
 *  what the §3.6 signature strip (Task 8) matches against PlacedRow's own
 *  input-order index — keep this ordering and drawTable's row order identical. */
export function buildFarmerTableRows(farmers: ConsolidatedFarmerRow[]): Cell[][] {
  return farmers.map((f, i) => [String(i + 1), f.name, itemsLine(f.items), f.batch ?? '', f.eDoc ?? '']);
}
