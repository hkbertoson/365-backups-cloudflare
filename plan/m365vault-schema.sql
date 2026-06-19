-- ============================================================
-- m365vault — D1 (SQLite) catalog schema
-- The searchable index that sits over the R2 blob store.
--
-- Design goals:
--   * incremental backup (delta-driven)
--   * content-addressed dedupe (store each unique blob in R2 once)
--   * CLEAN point-in-time restore via a temporal model
--     (each content state has a [valid_from, valid_to) interval)
-- All timestamps are INTEGER epoch-ms to match Date.now() in the worker.
-- ============================================================
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- tenants — one row per M365 tenant. The cron handler reads
-- backup_enabled here to decide which Workflows to start.
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

-- ------------------------------------------------------------
-- resources — Scope Containers (mailboxes and sites) and their expanded
-- Resources (drives) within a tenant. Per ADR 0002, a Resource is a
-- delta-trackable collection; mailboxes/sites are Scope Containers that
-- expand into Resources during discovery.
-- NOTE: the authoritative delta CURSOR lives in the TenantCoordinator
-- Durable Object (strong consistency). This table is a mirror for scope
-- discovery reporting only.
-- ------------------------------------------------------------
CREATE TABLE resources (
  resource_key      TEXT PRIMARY KEY,         -- '<kind>:<graph_id>'  e.g. 'mailbox:abc'
  tenant_id         TEXT NOT NULL REFERENCES tenants(tenant_id),
  kind              TEXT NOT NULL,            -- mailbox | drive | site
  graph_id          TEXT NOT NULL,
  display_name      TEXT,
  last_full_sync_at INTEGER,
  last_seen_run     TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_resources_tenant ON resources(tenant_id);

-- ------------------------------------------------------------
-- runs — each backup execution. A run IS a restore point;
-- started_at is the time anchor used for point-in-time queries.
-- ------------------------------------------------------------
CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,           -- uuid
  tenant_id       TEXT NOT NULL REFERENCES tenants(tenant_id),
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
CREATE INDEX idx_runs_tenant_time ON runs(tenant_id, started_at);

-- ------------------------------------------------------------
-- blobs — content-addressed store (single-instance storage).
-- The same content (e.g. one attachment forwarded to 100 mailboxes,
-- or an unchanged file across nightly runs) maps to ONE R2 object.
-- ref_count enables safe garbage collection at retention time.
-- ------------------------------------------------------------
CREATE TABLE blobs (
  content_hash TEXT PRIMARY KEY,              -- sha-256 of the content
  r2_key       TEXT NOT NULL,                 -- object key in R2
  size         INTEGER NOT NULL,
  ref_count    INTEGER NOT NULL DEFAULT 0,    -- # of item_versions pointing here
  created_at   INTEGER NOT NULL
);

-- ------------------------------------------------------------
-- items — the LOGICAL item identity (an email, a file, an event).
-- One row per real-world object; its content history lives in
-- item_versions.
-- ------------------------------------------------------------
CREATE TABLE items (
  item_uid       INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id      TEXT NOT NULL REFERENCES tenants(tenant_id),
  resource_key   TEXT NOT NULL REFERENCES resources(resource_key),
  graph_item_id  TEXT NOT NULL,               -- stable Graph id
  item_type      TEXT NOT NULL,               -- message | file | event | contact
  first_seen_run TEXT NOT NULL REFERENCES runs(run_id),
  last_seen_run  TEXT REFERENCES runs(run_id),
  UNIQUE (tenant_id, resource_key, graph_item_id)
);
CREATE INDEX idx_items_resource ON items(tenant_id, resource_key);

-- ------------------------------------------------------------
-- item_versions — TEMPORAL content states. The heart of versioning.
-- One row per observed content change. Validity interval is
-- [valid_from_ts, valid_to_ts); valid_to_ts IS NULL means "current".
-- ------------------------------------------------------------
CREATE TABLE item_versions (
  version_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  item_uid       INTEGER NOT NULL REFERENCES items(item_uid),
  content_hash   TEXT NOT NULL REFERENCES blobs(content_hash),
  name           TEXT,                        -- subject / filename
  parent_path    TEXT,                        -- folder or drive path (restore layout)
  metadata       TEXT,                        -- JSON (from/to/sent_at/...); encrypt if required
  valid_from_run TEXT NOT NULL REFERENCES runs(run_id),
  valid_from_ts  INTEGER NOT NULL,            -- = run.started_at when first observed
  valid_to_run   TEXT REFERENCES runs(run_id),
  valid_to_ts    INTEGER,                     -- NULL = still current
  is_deleted     INTEGER NOT NULL DEFAULT 0   -- tombstone: removed at source
);
CREATE INDEX idx_versions_item   ON item_versions(item_uid);
CREATE INDEX idx_versions_run    ON item_versions(valid_from_run);
CREATE INDEX idx_versions_window ON item_versions(item_uid, valid_from_ts, valid_to_ts);

-- Integrity guard: at most ONE open (current) version per item.
-- SQLite partial index makes this an enforced invariant, not a convention.
CREATE UNIQUE INDEX idx_one_current_version
  ON item_versions(item_uid) WHERE valid_to_ts IS NULL;

-- ============================================================
-- VIEWS & QUERY PATTERNS
-- ============================================================

-- Live state as of the most recent backup.
CREATE VIEW current_items AS
SELECT i.tenant_id, i.resource_key, i.graph_item_id, i.item_type,
       v.version_id, v.name, v.parent_path, v.metadata,
       b.r2_key, b.size
FROM items i
JOIN item_versions v ON v.item_uid = i.item_uid AND v.valid_to_ts IS NULL
JOIN blobs b         ON b.content_hash = v.content_hash
WHERE v.is_deleted = 0;

-- POINT-IN-TIME RESTORE — reconstruct a resource exactly as it looked
-- at the moment of run :run_id. This replaces the placeholder
-- `SELECT ... FROM index_items WHERE run_id = ?` in the worker skeleton:
-- it returns the version that was *current at that instant*, not merely
-- the items that happened to change during that run.
--
--   SELECT i.graph_item_id, i.item_type, v.name, v.parent_path,
--          v.metadata, b.r2_key, b.size
--   FROM runs r
--   JOIN items i         ON i.tenant_id = r.tenant_id
--   JOIN item_versions v ON v.item_uid = i.item_uid
--   JOIN blobs b         ON b.content_hash = v.content_hash
--   WHERE r.run_id = :run_id
--     AND i.resource_key = :resource_key
--     AND v.valid_from_ts <= r.started_at
--     AND (v.valid_to_ts IS NULL OR v.valid_to_ts > r.started_at)
--     AND v.is_deleted = 0;

-- ============================================================
-- WRITE PATH — what indexItem() does per observed item, in ONE txn:
--
--   1. INSERT OR IGNORE INTO items(...)            -> get/create item_uid
--   2. read current version:
--        SELECT content_hash FROM item_versions
--        WHERE item_uid = ? AND valid_to_ts IS NULL
--   3a. no current version      -> ensure blob row (++ref_count),
--                                  INSERT version (valid_to_ts NULL)
--   3b. hash unchanged          -> nothing to store; bump items.last_seen_run
--   3c. hash changed            -> UPDATE old version SET valid_to_ts = run.started_at,
--                                  ensure blob (++ref_count), INSERT new current version
--   deletion (delta says gone)  -> close current version + INSERT is_deleted tombstone
--
-- Only 3a / 3c actually write bytes to R2 — and only when the blob's
-- content_hash is new — which is where the dedupe savings come from.
-- ============================================================

-- ============================================================
-- RETENTION / GC (scheduled job):
--   1. find versions with valid_to_ts < (now - retention_days)
--   2. for each: -- ref_count, then DELETE the version row
--   3. DELETE FROM blobs WHERE ref_count = 0  -> delete those R2 objects
-- R2 Object Lock enforces an immutability floor independently, so GC
-- can never delete inside the locked retention window.
-- ============================================================
