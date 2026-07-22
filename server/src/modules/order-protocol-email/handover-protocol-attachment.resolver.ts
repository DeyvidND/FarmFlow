import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { HandoverService } from '../handover/handover.service';
import { ConsolidatedProtocolService } from '../handover/consolidated-protocol.service';
import type {
  ProtocolAttachmentResolver,
  ProtocolAttachmentDescriptor,
} from '../../common/email/protocol-attachment.types';

@Injectable()
export class HandoverProtocolAttachmentResolver implements ProtocolAttachmentResolver {
  // Resolve the two protocol services LAZILY (at resolve() time) instead of via
  // constructor injection. EmailService @Optional-injects this resolver, and both
  // HandoverService and ConsolidatedProtocolService transitively inject
  // EmailService back — a constructor-time provider cycle
  // (EmailService → resolver → ConsolidatedProtocolService → EmailService) that
  // hangs NestFactory.create at DI resolution. Fetching them on demand, after the
  // graph is fully built, breaks the cycle. strict:false searches the whole app
  // (both live in HandoverModule, not this one). Guarded by an AppModule-bootstrap
  // spec so the cycle can't silently return.
  constructor(private readonly moduleRef: ModuleRef) {}

  async resolve(d: ProtocolAttachmentDescriptor): Promise<{ filename: string; content: Buffer }> {
    if (d.kind === 'consolidated-protocol') {
      const consolidated = this.moduleRef.get(ConsolidatedProtocolService, { strict: false });
      const view = await consolidated.getView(d.tenantId, d.consolidatedProtocolId);
      // getPdf (not renderPdf): a SIGNED leg emailed to its courier must be the
      // exact archived bytes — the same byte-for-byte legal record the download
      // route serves — never a fresh re-render that could drift from it.
      const content = await consolidated.getPdf(d.tenantId, view);
      return { filename: `obobshten-protokol-OB-${view.docNumber}.pdf`, content };
    }
    const handover = this.moduleRef.get(HandoverService, { strict: false });
    const content = await handover.renderPdfForEmail(d.tenantId, d.protocolId);
    return { filename: `protokol-${d.protocolId}.pdf`, content };
  }
}
