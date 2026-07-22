import { Injectable } from '@nestjs/common';
import { HandoverService } from '../handover/handover.service';
import type {
  ProtocolAttachmentResolver,
  HandoverProtocolAttachmentDescriptor,
} from '../../common/email/protocol-attachment.types';

@Injectable()
export class HandoverProtocolAttachmentResolver implements ProtocolAttachmentResolver {
  constructor(private readonly handover: HandoverService) {}

  async resolve(d: HandoverProtocolAttachmentDescriptor): Promise<{ filename: string; content: Buffer }> {
    const content = await this.handover.renderPdfForEmail(d.tenantId, d.protocolId);
    return { filename: `protokol-${d.protocolId}.pdf`, content };
  }
}
