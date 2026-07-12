-- Producer map (logistics): cached geocoded coordinates per producer, resolved from
-- legal.address / city via MapsService (Google, 30-day Redis cache) and persisted so the map
-- endpoint and future route planning read them without re-geocoding. NULL = not yet resolved;
-- geocoded_at is the refresh/audit stamp.
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "lat" numeric(10, 7);
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "lng" numeric(10, 7);
ALTER TABLE "farmers" ADD COLUMN IF NOT EXISTS "geocoded_at" timestamp with time zone;
