import { HandoverProtocolAttachmentResolver } from './handover-protocol-attachment.resolver';

function buildDeps() {
  const handover = {
    renderPdfForEmail: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 handover bytes')),
  };
  const consolidated = {
    getView: jest.fn(),
    renderPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 consolidated bytes')),
  };
  return { handover, consolidated };
}

describe('HandoverProtocolAttachmentResolver — dispatch by kind', () => {
  it('still renders the bilateral handover PDF for kind=handover-protocol (unchanged behavior)', async () => {
    const { handover, consolidated } = buildDeps();
    const resolver = new HandoverProtocolAttachmentResolver(handover as any, consolidated as any);

    const out = await resolver.resolve({ kind: 'handover-protocol', protocolId: 'p1', tenantId: 't1' });

    expect(handover.renderPdfForEmail).toHaveBeenCalledWith('t1', 'p1');
    expect(consolidated.getView).not.toHaveBeenCalled();
    expect(out.content).toEqual(Buffer.from('%PDF-1.4 handover bytes'));
    expect(out.filename).toBe('protokol-p1.pdf');
  });

  it('renders the CONSOLIDATED protocol PDF for kind=consolidated-protocol — loads the view then renders it', async () => {
    const { handover, consolidated } = buildDeps();
    consolidated.getView.mockResolvedValue({ id: 'cp1', docNumber: 42, scope: 'leg', legIndex: 1 });
    const resolver = new HandoverProtocolAttachmentResolver(handover as any, consolidated as any);

    const out = await resolver.resolve({ kind: 'consolidated-protocol', consolidatedProtocolId: 'cp1', tenantId: 't1' });

    expect(consolidated.getView).toHaveBeenCalledWith('t1', 'cp1');
    // The rendered view is THE ONE getView actually returned — not a fresh
    // fetch/refetch — proving the resolver renders what it loaded.
    const renderedView = consolidated.renderPdf.mock.calls[0][1];
    expect(renderedView).toEqual({ id: 'cp1', docNumber: 42, scope: 'leg', legIndex: 1 });
    expect(consolidated.renderPdf).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'cp1' }));
    expect(handover.renderPdfForEmail).not.toHaveBeenCalled();
    expect(out.content).toEqual(Buffer.from('%PDF-1.4 consolidated bytes'));
    expect(out.filename).toBe('obobshten-protokol-OB-42.pdf');
  });
});
