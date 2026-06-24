export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'ApiError'; }
}
function firstMsg(body: unknown, fallback: string): string {
  const outer = (body as { message?: unknown })?.message;
  const inner = outer && typeof outer === 'object' && !Array.isArray(outer) ? (outer as { message?: unknown }).message : outer;
  if (Array.isArray(inner)) return typeof inner[0] === 'string' ? inner[0] : fallback;
  if (typeof inner === 'string') return inner;
  return fallback;
}
async function bff(path: string, init?: RequestInit, fallback = 'Възникна грешка'): Promise<Response> {
  const res = await fetch(`/bff/${path}`, init);
  if (!res.ok) {
    const b = await res.clone().json().catch(() => ({}));
    throw new ApiError(res.status, firstMsg(b, fallback));
  }
  return res;
}

export interface ImportRow {
  id: string;
  rowIndex: number;
  receiverName: string | null;
  receiverPhone: string | null;
  deliveryMode: 'office' | 'address' | null;
  city: string | null;
  office: string | null;
  address: string | null;
  weightGrams: number | null;
  codAmountStotinki: number | null;
  carrier: 'econt' | 'speedy';
  validationStatus: 'ok' | 'warn' | 'error';
  validation?: { issues?: Array<{ message: string }> } | null;
  shipmentId?: string | null;
}
export interface ImportBatch {
  batch: { id: string; aiReport?: { aiAvailable?: boolean } | null };
  rows: ImportRow[];
}

export const uploadBatch = async (file: File, settings: Record<string, string>): Promise<ImportBatch> => {
  const fd = new FormData();
  fd.append('file', file);
  Object.entries(settings).forEach(([k, v]) => { if (v != null && v !== '') fd.append(k, v); });
  const res = await bff('import/batches', { method: 'POST', body: fd }, 'Качването се провали');
  return res.json();
};
export const getBatch = async (id: string): Promise<ImportBatch> =>
  (await bff(`import/batches/${id}`)).json();
export const patchRow = async (batchId: string, rowId: string, patch: Partial<ImportRow>): Promise<ImportRow> =>
  (await bff(`import/batches/${batchId}/rows/${rowId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  })).json();
export const deleteRow = async (batchId: string, rowId: string): Promise<void> => {
  await bff(`import/batches/${batchId}/rows/${rowId}`, { method: 'DELETE' });
};
export const commitBatch = async (batchId: string): Promise<{ results: Array<{ status: string; shipmentId?: string }>; failed?: number }> =>
  (await bff(`import/batches/${batchId}/commit`, { method: 'POST' }, 'Създаването се провали')).json();
export const downloadLabels = async (carrier: 'econt' | 'speedy', ids: string[]): Promise<void> => {
  const path = carrier === 'speedy' ? 'speedy/labels.pdf' : 'shipping/labels.pdf';
  const res = await bff(`${path}?ids=${ids.join(',')}`);
  const blob = await res.blob();
  window.open(URL.createObjectURL(blob), '_blank');
};
export const templateUrl = '/bff/import/template.xlsx';
