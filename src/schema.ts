// ============================================================
// Per-tenant catalog schema — applied to each TenantCoordinator DO's
// SQLite (ADR 0003). The DO boundary IS the tenant, so these tables carry
// no tenant_id column and no FK to the control-plane `tenants` table
// (which lives in a separate D1 database).
//
// NOTE: unlike D1 (which leaves foreign keys off by default), DO SQLite
// ENFORCES declared foreign keys. The catalog never relied on FKs for
// integrity — the real guard is the partial UNIQUE index (one current version
// per item) — and `resources` is an as-yet-unpopulated mirror (scope discovery
// is deferred). So no REFERENCES clauses are declared here; an enforced FK to a
// table we don't populate yet would just fail every items insert.
//
// Applied idempotently from the DO constructor via ctx.storage.sql.exec,
// so every statement is CREATE ... IF NOT EXISTS. All timestamps are
// INTEGER epoch-ms to match Date.now() in the worker.
// ============================================================
export const CATALOG_SCHEMA = `
-- resources — backup targets within the tenant (mailbox / drive / site).
-- The authoritative delta CURSOR lives in DO storage (cursor: keys); this
-- table is a mirror for reporting and scope discovery only.
CREATE TABLE IF NOT EXISTS resources (
  resource_key      TEXT PRIMARY KEY,         -- '<kind>:<graph_id>'
  kind              TEXT NOT NULL,            -- mailbox | drive | site
  graph_id          TEXT NOT NULL,
  display_name      TEXT,
  last_full_sync_at INTEGER,
  last_seen_run     TEXT,
  created_at        INTEGER NOT NULL
);

-- runs — each backup execution. A run IS a restore point; started_at is the
-- time anchor used for point-in-time queries.
CREATE TABLE IF NOT EXISTS runs (
  run_id          TEXT PRIMARY KEY,           -- uuid
  kind            TEXT NOT NULL,              -- full | incremental
  status          TEXT NOT NULL,              -- running | completed | partial | failed
  started_at      INTEGER NOT NULL,           -- <-- point-in-time anchor (T)
  finished_at     INTEGER,
  expires_at      INTEGER,                    -- started_at + retention, drives GC
  total_resources INTEGER NOT NULL DEFAULT 0,
  item_count      INTEGER NOT NULL DEFAULT 0,
  bytes_logical   INTEGER NOT NULL DEFAULT 0, -- summed item sizes (pre-dedupe)
  bytes_stored    INTEGER NOT NULL DEFAULT 0  -- bytes actually written to R2 (post-dedupe)
);
CREATE INDEX IF NOT EXISTS idx_runs_time ON runs(started_at);

-- blobs — content-addressed store. The same content maps to ONE R2 object;
-- ref_count enables safe garbage collection at retention time. Dedupe is
-- per-tenant by construction (this table lives in the tenant's own DO).
CREATE TABLE IF NOT EXISTS blobs (
  content_hash TEXT PRIMARY KEY,              -- sha-256 of the content
  r2_key       TEXT NOT NULL,                 -- object key in R2
  size         INTEGER NOT NULL,
  ref_count    INTEGER NOT NULL DEFAULT 0,    -- # of item_versions pointing here
  created_at   INTEGER NOT NULL
);

-- items — the LOGICAL item identity (an email, a file, an event). One row
-- per real-world object; its content history lives in item_versions.
CREATE TABLE IF NOT EXISTS items (
  item_uid       INTEGER PRIMARY KEY AUTOINCREMENT,
  resource_key   TEXT NOT NULL,
  graph_item_id  TEXT NOT NULL,               -- stable Graph id
  item_type      TEXT NOT NULL,               -- message | file | event | contact
  first_seen_run TEXT NOT NULL,
  last_seen_run  TEXT,
  UNIQUE (resource_key, graph_item_id)
);
CREATE INDEX IF NOT EXISTS idx_items_resource ON items(resource_key);

-- item_versions — TEMPORAL content states. One row per observed content
-- change; validity interval is [valid_from_ts, valid_to_ts); valid_to_ts
-- IS NULL means "current".
CREATE TABLE IF NOT EXISTS item_versions (
  version_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  item_uid       INTEGER NOT NULL,
  content_hash   TEXT NOT NULL,
  name           TEXT,                        -- subject / filename
  parent_path    TEXT,                        -- folder or drive path (restore layout)
  metadata       TEXT,                        -- JSON (from/to/sent_at/...)
  valid_from_run TEXT NOT NULL,
  valid_from_ts  INTEGER NOT NULL,            -- = run.started_at when first observed
  valid_to_run   TEXT,
  valid_to_ts    INTEGER,                     -- NULL = still current
  is_deleted     INTEGER NOT NULL DEFAULT 0   -- tombstone: removed at source
);
CREATE INDEX IF NOT EXISTS idx_versions_item   ON item_versions(item_uid);
CREATE INDEX IF NOT EXISTS idx_versions_run    ON item_versions(valid_from_run);
CREATE INDEX IF NOT EXISTS idx_versions_window ON item_versions(item_uid, valid_from_ts, valid_to_ts);

-- Integrity guard: at most ONE open (current) version per item.
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_version
  ON item_versions(item_uid) WHERE valid_to_ts IS NULL;

-- Lookup support for retention/GC: closed versions expiring past a cutoff.
CREATE INDEX IF NOT EXISTS idx_versions_closed
  ON item_versions(valid_to_ts) WHERE valid_to_ts IS NOT NULL;

-- Live state as of the most recent backup.
CREATE VIEW IF NOT EXISTS current_items AS
SELECT i.resource_key, i.graph_item_id, i.item_type,
       v.version_id, v.name, v.parent_path, v.metadata,
       b.r2_key, b.size
FROM items i
JOIN item_versions v ON v.item_uid = i.item_uid AND v.valid_to_ts IS NULL
JOIN blobs b         ON b.content_hash = v.content_hash
WHERE v.is_deleted = 0;
`;
