/** Descriptor for a lazily-materialized email attachment. `kind` dispatches which
 *  document gets rendered — the bilateral customer protocol, or (§4.4) a
 *  courier's own leg of the обобщен (consolidated) protocol. Both resolve
 *  through the SAME token/resolver, switched on `kind`. */
export interface HandoverProtocolAttachmentDescriptor {
  kind: 'handover-protocol';
  protocolId: string;
  tenantId: string;
}

/** §4.4 "Прати на куриерите" — one courier's own leg of the consolidated
 *  protocol, never the day protocol nor another leg's. */
export interface ConsolidatedProtocolAttachmentDescriptor {
  kind: 'consolidated-protocol';
  consolidatedProtocolId: string;
  tenantId: string;
}

export type ProtocolAttachmentDescriptor =
  | HandoverProtocolAttachmentDescriptor
  | ConsolidatedProtocolAttachmentDescriptor;

export interface ProtocolAttachmentResolver {
  resolve(d: ProtocolAttachmentDescriptor): Promise<{ filename: string; content: Buffer }>;
}

export const PROTOCOL_ATTACHMENT_RESOLVER = Symbol('PROTOCOL_ATTACHMENT_RESOLVER');
