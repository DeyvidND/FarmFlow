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
      const content = await this.consolidated.renderPdf(d.tenantId, view);
      return { filename: `obobshten-protokol-OB-${view.docNumber}.pdf`, content };
    }
    const content = await this.handover.renderPdfForEmail(d.tenantId, d.protocolId);
    return { filename: `protokol-${d.protocolId}.pdf`, content };
  }
}
