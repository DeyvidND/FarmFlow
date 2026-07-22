/** Descriptor for a lazily-materialized email attachment. Only one `kind` exists
 *  today; more (e.g. a future `kind: 'consolidated-protocol'` for §4.4) get their
 *  own resolver registered against the same token, dispatched by `kind`. */
export interface HandoverProtocolAttachmentDescriptor {
  kind: 'handover-protocol';
  protocolId: string;
  tenantId: string;
}

export interface ProtocolAttachmentResolver {
  resolve(d: HandoverProtocolAttachmentDescriptor): Promise<{ filename: string; content: Buffer }>;
}

export const PROTOCOL_ATTACHMENT_RESOLVER = Symbol('PROTOCOL_ATTACHMENT_RESOLVER');
