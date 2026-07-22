import { HandoverProtocolAttachmentResolver } from './handover-protocol-attachment.resolver';

function buildDeps() {
  const handover = {
    renderPdfForEmail: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 handover bytes')),
  };
  const consolidated = {
    getView: jest.fn(),
    getPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4 consolidated bytes')),
  };
  return { handover, consolidated };
}

/** The resolver now pulls its services LAZILY via ModuleRef (breaks a provider
 *  cycle). The mock returns the right stub per token name. */
function makeResolver(handover: unknown, consolidated: unknown) {
  const moduleRef = {
    get: jest.fn((token: any) => (token?.name === 'ConsolidatedProtocolService' ? consolidated : handover)),
  };
  return new HandoverProtocolAttachmentResolver(moduleRef as any);
}

describe('HandoverProtocolAttachmentResolver — dispatch by kind', () => {
  it('still renders the bilateral handover PDF for kind=handover-protocol (unchanged behavior)', async () => {
    const { handover, consolidated } = buildDeps();
    const resolver = makeResolver(handover, consolidated);

    const out = await resolver.resolve({ kind: 'handover-protocol', protocolId: 'p1', tenantId: 't1' });

    expect(handover.renderPdfForEmail).toHaveBeenCalledWith('t1', 'p1');
    expect(consolidated.getView).not.toHaveBeenCalled();
    expect(out.content).toEqual(Buffer.from('%PDF-1.4 handover bytes'));
    expect(out.filename).toBe('protokol-p1.pdf');
  });

  it('renders the CONSOLIDATED protocol PDF for kind=consolidated-protocol — loads the view then renders it', async () => {
    const { handover, consolidated } = buildDeps();
    consolidated.getView.mockResolvedValue({ id: 'cp1', docNumber: 42, scope: 'leg', legIndex: 1 });
    const resolver = makeResolver(handover, consolidated);

    const out = await resolver.resolve({ kind: 'consolidated-protocol', consolidatedProtocolId: 'cp1', tenantId: 't1' });

    expect(consolidated.getView).toHaveBeenCalledWith('t1', 'cp1');
    // The rendered view is THE ONE getView actually returned — not a fresh
    // fetch/refetch — proving the resolver serves what it loaded. getPdf (not
    // renderPdf) so a signed leg emails its archived bytes, not a re-render.
    const renderedView = consolidated.getPdf.mock.calls[0][1];
    expect(renderedView).toEqual({ id: 'cp1', docNumber: 42, scope: 'leg', legIndex: 1 });
    expect(consolidated.getPdf).toHaveBeenCalledWith('t1', expect.objectContaining({ id: 'cp1' }));
    expect(handover.renderPdfForEmail).not.toHaveBeenCalled();
    expect(out.content).toEqual(Buffer.from('%PDF-1.4 consolidated bytes'));
    expect(out.filename).toBe('obobshten-protokol-OB-42.pdf');
  });
});
