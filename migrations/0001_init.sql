-- ============================================================
-- m365vault — control-plane D1 schema (migration 0001)
-- The shared registry the cron reads to decide which tenants to back up.
--
-- The per-tenant CATALOG (resources/runs/blobs/items/item_versions) does NOT
-- live here — it lives in each tenant's TenantCoordinator Durable Object
-- SQLite (ADR 0003), defined in src/schema.ts. This database holds ONLY the
-- tenant registry, so it stays tiny regardless of catalog scale.
-- All timestamps are INTEGER epoch-ms to match Date.now() in the worker.
-- ============================================================

-- ------------------------------------------------------------
-- tenants — one row per M365 tenant. The cron handler reads
-- backup_enabled here to decide which Workflows to start, and
-- retention_days to anchor each run's expiry / GC cutoff.
-- ------------------------------------------------------------
CREATE TABLE tenants (
  tenant_id      TEXT PRIMARY KEY,            -- Azure AD tenant GUID
  display_name   TEXT NOT NULL,
  backup_enabled INTEGER NOT NULL DEFAULT 1,  -- 0/1
  schedule_cron  TEXT,                        -- e.g. '0 3 * * *'
  retention_days INTEGER NOT NULL DEFAULT 90,
  last_run_id    TEXT,
  last_run_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
