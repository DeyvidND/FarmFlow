import { shipments } from '@fermeribg/db';

export type Carrier = 'econt' | 'speedy';

/** A persisted shipment row — the shape every carrier returns for a waybill op. */
export type ShipmentRow = typeof shipments.$inferSelect;

/**
 * The carrier-agnostic operations a waybill goes through, implemented identically
 * (same signatures) by both `EcontService` and `SpeedyService`. Routing by carrier
 * — the dispatcher and the generic carrier controller — depends only on this
 * contract, never on a concrete service, so adding a third carrier is a matter of
 * implementing it and registering in `CarrierRegistry`.
 *
 * Carrier-specific concerns (credentials, nomenclature, estimate — whose inputs
 * genuinely differ per carrier) deliberately stay off this interface. This file
 * imports no service, so the services can `implements CarrierAdapter` without a
 * circular import.
 */
export interface CarrierAdapter {
  /** Best-effort, idempotent waybill creation for a paid order (self-gates). */
  autoCreateForOrder(orderId: string): Promise<void>;
  /** Create (or return the existing) waybill for an order, on demand. */
  createLabelForOrder(tenantId: string, orderId: string): Promise<ShipmentRow>;
  /** Re-pull a single shipment's status from the carrier. */
  refreshStatus(tenantId: string, shipmentId: string): Promise<ShipmentRow>;
  /** Cancel/void a shipment's waybill. */
  voidShipment(tenantId: string, shipmentId: string): Promise<{ id: string }>;
  /** A single shipment's label PDF. */
  getLabelPdf(tenantId: string, shipmentId: string): Promise<Buffer>;
  /** A merged label PDF for several shipments (bulk print). */
  getLabelsPdf(tenantId: string, shipmentIds: string[]): Promise<Buffer>;
  /** Cron entry point — refresh every still-active shipment for this carrier. */
  refreshActiveShipments(): Promise<{ refreshed: number }>;
}
