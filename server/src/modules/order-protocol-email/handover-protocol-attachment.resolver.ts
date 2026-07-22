import { Injectable } from '@nestjs/common';
import { HandoverService } from '../handover/handover.service';
import { ConsolidatedProtocolService } from '../handover/consolidated-protocol.service';
import type {
  ProtocolAttachmentResolver,
  ProtocolAttachmentDescriptor,
} from '../../common/email/protocol-attachment.types';

@Injectable()
export class HandoverProtocolAttachmentResolver implements ProtocolAttachmentResolver {
  constructor(
    private readonly handover: HandoverService,
    private readonly consolidated: ConsolidatedProtocolService,
  ) {}

  async resolve(d: ProtocolAttachmentDescriptor): Promise<{ filename: string; content: Buffer }> {
    if (d.kind === 'consolidated-protocol') {
      const view = await this.consolidated.getView(d.tenantId, d.consolidatedProtocolId);
      // getPdf (not renderPdf): a SIGNED leg emailed to its courier must be the
      // exact archived bytes — the same byte-for-byte legal record the download
      // route serves — never a fresh re-render that could drift from it.
      const content = await this.consolidated.getPdf(d.tenantId, view);
      return { filename: `obobshten-protokol-OB-${view.docNumber}.pdf`, content };
    }
    const content = await this.handover.renderPdfForEmail(d.tenantId, d.protocolId);
    return { filename: `protokol-${d.protocolId}.pdf`, content };
  }
}
