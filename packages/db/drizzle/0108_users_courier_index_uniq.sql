CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_courier_index_uniq" ON "users" ("tenant_id","courier_index") WHERE role = 'driver' and courier_index is not null;
