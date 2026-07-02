CREATE TABLE IF NOT EXISTS site_events (
  id            bigserial PRIMARY KEY,
  tenant_id     uuid REFERENCES tenants(id),
  visitor_hash  text NOT NULL,
  event_type    text NOT NULL,
  path          text,
  referrer_host text,
  product_id    uuid,
  order_id      uuid,
  value_stotinki integer,
  device        text NOT NULL DEFAULT 'desktop',
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_events_tenant_created_idx ON site_events (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS site_events_tenant_type_created_idx ON site_events (tenant_id, event_type, created_at);
