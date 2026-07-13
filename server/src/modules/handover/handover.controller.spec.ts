import { StreamableFile } from '@nestjs/common';
import { HandoverController } from './handover.controller';

/** Direct-instantiation controller spec (no Nest TestingModule needed) —
 *  mirrors orders.controller.spec.ts: verify each route delegates to the
 *  service with the `@CurrentTenant()`-injected tenantId, and that the two
 *  PDF routes return a `StreamableFile` typed `application/pdf`. */
describe('HandoverController delegation', () => {
  const svc = {
    buildDraft: jest.fn().mockResolvedValue({ kind: 'farmer_to_operator' }),
    createSigned: jest.fn().mockResolvedValue({ id: 'p1', protocolNumber: 1 }),
    list: jest.fn().mockResolvedValue([{ id: 'p1' }]),
    createBatch: jest.fn().mockResolvedValue({ ids: ['p1'] }),
    listForDay: jest.fn().mockResolvedValue([{ id: null }]),
    renderPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
    renderBatchPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
    renderPreviewPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4')),
    markSigned: jest.fn().mockResolvedValue(undefined),
    signPaperTarget: jest.fn().mockResolvedValue({ id: 'p1' }),
  };
  const ctrl = new HandoverController(svc as any);

  beforeEach(() => jest.clearAllMocks());

  it('GET /handover/draft delegates buildDraft with tenantId + query', async () => {
    const q = { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' } as any;
    await ctrl.draft('t1', q);
    expect(svc.buildDraft).toHaveBeenCalledWith('t1', q);
  });

  it('POST /handover delegates createSigned with tenantId + body', async () => {
    const dto = { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1', items: [] } as any;
    await ctrl.create('t1', dto);
    expect(svc.createSigned).toHaveBeenCalledWith('t1', dto);
  });

  it('GET /handover delegates list with tenantId + query filters', async () => {
    await ctrl.list('t1', 's1', '2026-07-13', 'farmer_to_operator');
    expect(svc.list).toHaveBeenCalledWith('t1', {
      slotId: 's1',
      date: '2026-07-13',
      kind: 'farmer_to_operator',
    });
  });

  it('POST /handover/batch delegates createBatch with tenantId + body', async () => {
    const dto = { slotId: 's1' } as any;
    await ctrl.createBatch('t1', dto);
    expect(svc.createBatch).toHaveBeenCalledWith('t1', dto);
  });

  it('GET /handover/day delegates listForDay with tenantId + slot/date', async () => {
    await ctrl.listForDay('t1', 's1', '2026-07-16');
    expect(svc.listForDay).toHaveBeenCalledWith('t1', { slotId: 's1', date: '2026-07-16' });
  });

  it('PATCH /handover/:id/mark-signed delegates markSigned with tenantId + id', async () => {
    await ctrl.markSigned('t1', 'p1');
    expect(svc.markSigned).toHaveBeenCalledWith('t1', 'p1');
  });

  it('POST /handover/sign-paper delegates signPaperTarget with tenantId + body', async () => {
    const dto = { kind: 'operator_to_customer', orderId: 'o1' } as any;
    await ctrl.signPaper('t1', dto);
    expect(svc.signPaperTarget).toHaveBeenCalledWith('t1', dto);
  });

  it('GET /handover/preview.pdf delegates renderPreviewPdf and returns an inline application/pdf StreamableFile', async () => {
    const q = { kind: 'farmer_to_operator', farmerId: 'f1', slotId: 's1' } as any;
    const result = await ctrl.previewPdf('t1', q);
    expect(svc.renderPreviewPdf).toHaveBeenCalledWith('t1', q);
    expect(result).toBeInstanceOf(StreamableFile);
    expect(result.getHeaders().type).toBe('application/pdf');
  });

  it('GET /handover/:id/pdf delegates renderPdf and returns an inline application/pdf StreamableFile', async () => {
    const result = await ctrl.pdf('t1', 'p1');
    expect(svc.renderPdf).toHaveBeenCalledWith('t1', 'p1');
    expect(result).toBeInstanceOf(StreamableFile);
    const headers = result.getHeaders();
    expect(headers.type).toBe('application/pdf');
    expect(headers.disposition).toContain('inline');
  });

  it('GET /handover/batch.pdf delegates renderBatchPdf and returns an inline application/pdf StreamableFile', async () => {
    const dto = { slotId: 's1' } as any;
    const result = await ctrl.batchPdf('t1', dto);
    expect(svc.renderBatchPdf).toHaveBeenCalledWith('t1', dto);
    expect(result).toBeInstanceOf(StreamableFile);
    const headers = result.getHeaders();
    expect(headers.type).toBe('application/pdf');
    expect(headers.disposition).toContain('inline');
  });
});
