---
title: Data model
description: The per-tenant catalog tables in TenantCoordinator DO SQLite and the D1 control-plane tenants registry, column by column.
---

m365vault splits its persisted state across two databases:

- The **control-plane registry** — a single D1 database (`DB`) holding only the `tenants` table. It stays tiny regardless of catalog scale.
- The **per-Tenant catalog** — one SQLite database embedded in each `TenantCoordinator` Durable Object (ADR 0003). Because the DO boundary _is_ the Tenant, catalog tables carry no `tenant_id` column.

All timestamps are `INTEGER` epoch-milliseconds to match `Date.now()` in the Worker. For why the catalog is bitemporal and how validity intervals resolve a Restore Point, see [the temporal model](/concepts/temporal-model/). For how the bytes and the catalog relate at runtime, see [storage and catalog](/architecture/storage-and-catalog/).

## Control-plane: `tenants` (D1)

One row per Microsoft 365 Tenant. The daily cron reads `backup_enabled` to decide which Workflows to start and `retention_days` to anchor each Run's expiry and GC cutoff. Defined in `migrations/0001_init.sql`.

```sql
CREATE TABLE tenants (
  tenant_id      TEXT PRIMARY KEY,            -- Azure AD tenant GUID
  display_name   TEXT NOT NULL,
  backup_enabled INTEGER NOT NULL DEFAULT 1 CHECK (backup_enabled IN (0, 1)),
  schedule_cron  TEXT,                        -- e.g. '0 3 * * *'
  retention_days INTEGER NOT NULL DEFAULT 90 CHECK (retention_days > 0),
  last_run_id    TEXT,
  last_run_at    INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
```

| Column                      | Meaning                                                                                                           |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `tenant_id`                 | The Azure AD tenant GUID. Primary key, and the name passed to `idFromName` to route the Tenant's DO.              |
| `display_name`              | Human-readable Tenant name.                                                                                       |
| `backup_enabled`            | `0`/`1` gate the daily cron checks before starting a Workflow.                                                    |
| `schedule_cron`             | Optional per-Tenant cron expression for the backup schedule.                                                      |
| `retention_days`            | Days a Run's data is kept; anchors each Run's `expires_at` and the GC cutoff. Must be positive; defaults to `90`. |
| `last_run_id`               | The `run_id` of the most recent Run for this Tenant.                                                              |
| `last_run_at`               | When the most recent Run started (epoch-ms).                                                                      |
| `created_at` / `updated_at` | Row lifecycle timestamps (epoch-ms).                                                                              |

## Per-Tenant catalog (DO SQLite)

The catalog schema lives in `src/schema.ts` as `CATALOG_SCHEMA` and is applied idempotently from the DO constructor (every statement is `CREATE ... IF NOT EXISTS`). DO SQLite _enforces_ declared foreign keys, so the schema deliberately declares **no** `REFERENCES` clauses — integrity rests on the partial unique index, not FKs.

### `resources`

Backup targets within the Tenant. The authoritative Delta Cursor lives in DO storage under `cursor:` keys; this table is a mirror for reporting and scope discovery only (and is as-yet unpopulated, since scope discovery is deferred).

```sql
CREATE TABLE IF NOT EXISTS resources (
  resource_key      TEXT PRIMARY KEY,         -- '<kind>:<graph_id>'
  kind              TEXT NOT NULL,            -- mailfolder | drive | site
  graph_id          TEXT NOT NULL,
  display_name      TEXT,
  last_full_sync_at INTEGER,
  last_seen_run     TEXT,
  created_at        INTEGER NOT NULL
);
```

| Column              | Meaning                                                                                                                                      |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `resource_key`      | `"<kind>:<graph_id>"`; for a mail folder it is `"mailfolder:<ownerId>:<folderId>"` because folder ids are mailbox-scoped, not tenant-unique. |
| `kind`              | `mailfolder`, `drive`, or `site`.                                                                                                            |
| `graph_id`          | The Graph object id of the Resource.                                                                                                         |
| `display_name`      | Optional friendly name.                                                                                                                      |
| `last_full_sync_at` | When the Resource was last fully resynced (epoch-ms).                                                                                        |
| `last_seen_run`     | The most recent Run that observed this Resource.                                                                                             |
| `created_at`        | When the row was first written (epoch-ms).                                                                                                   |

### `runs`

Each backup execution. A Run **is** a Restore Point; `started_at` is the point-in-time anchor that every temporal query resolves against.

```sql
CREATE TABLE IF NOT EXISTS runs (
  run_id          TEXT PRIMARY KEY,           -- uuid
  kind            TEXT NOT NULL,              -- full | incremental
  status          TEXT NOT NULL,              -- running | completed | partial | failed
  started_at      INTEGER NOT NULL,           -- point-in-time anchor (T)
  finished_at     INTEGER,
  expires_at      INTEGER,                    -- started_at + retention, drives GC
  total_resources INTEGER NOT NULL DEFAULT 0,
  item_count      INTEGER NOT NULL DEFAULT 0,
  bytes_logical   INTEGER NOT NULL DEFAULT 0, -- summed item sizes (pre-dedupe)
  bytes_stored    INTEGER NOT NULL DEFAULT 0  -- bytes actually written to R2 (post-dedupe)
);
CREATE INDEX IF NOT EXISTS idx_runs_time ON runs(started_at);
```

| Column            | Meaning                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `run_id`          | UUID for the Run; the value joined into Item Version `valid_from_run` / `valid_to_run`.                  |
| `kind`            | `full` (a Seed) or `incremental`.                                                                        |
| `status`          | `running`, `completed`, `partial`, or `failed`.                                                          |
| `started_at`      | The Restore Point's time anchor `T`; the value used as `valid_from_ts` when a Version is first observed. |
| `finished_at`     | When the Run finished (epoch-ms), or `NULL` while running.                                               |
| `expires_at`      | `started_at + retention`; drives retention GC.                                                           |
| `total_resources` | Number of Resources in scope for the Run.                                                                |
| `item_count`      | Items observed in the Run.                                                                               |
| `bytes_logical`   | Summed Item sizes before dedupe.                                                                         |
| `bytes_stored`    | Bytes actually written to R2 after content-addressed dedupe.                                             |

### `blobs`

The content-addressed store. The same content maps to one R2 object; `ref_count` enables safe garbage collection at retention time. Dedupe is per-Tenant by construction, because this table lives in the Tenant's own DO.

```sql
CREATE TABLE IF NOT EXISTS blobs (
  content_hash TEXT PRIMARY KEY,              -- sha-256 of the content
  r2_key       TEXT NOT NULL,                 -- object key in R2
  size         INTEGER NOT NULL,
  ref_count    INTEGER NOT NULL DEFAULT 0,    -- # of item_versions pointing here
  created_at   INTEGER NOT NULL
);
```

| Column         | Meaning                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------- |
| `content_hash` | The content address — a sha-256 of the bytes, or a Graph `etag:` surrogate for streamed mail and large files. |
| `r2_key`       | The object key in the `BLOBS` R2 bucket.                                                                      |
| `size`         | Object size in bytes.                                                                                         |
| `ref_count`    | Number of Item Versions pointing at this Blob; a Blob is reclaimable when it reaches `0`.                     |
| `created_at`   | When the Blob was first written (epoch-ms).                                                                   |

### `items`

The logical Item identity — an email, a file, an event, a contact. One row per real-world object; its content history lives in `item_versions`.

```sql
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
```

| Column                                 | Meaning                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `item_uid`                             | Internal auto-increment identity, referenced by `item_versions.item_uid`. |
| `resource_key`                         | The owning Resource.                                                      |
| `graph_item_id`                        | The stable Graph id of the Item.                                          |
| `item_type`                            | `message`, `file`, `event`, or `contact`.                                 |
| `first_seen_run` / `last_seen_run`     | The first and most recent Runs that observed the Item.                    |
| `UNIQUE (resource_key, graph_item_id)` | One logical Item per Graph id within a Resource.                          |

### `item_versions`

The temporal content states. One row per observed content change; the validity interval is the half-open `[valid_from_ts, valid_to_ts)`, and `valid_to_ts IS NULL` means the Version is current.

```sql
CREATE TABLE IF NOT EXISTS item_versions (
  version_id     INTEGER PRIMARY KEY AUTOINCREMENT,
  item_uid       INTEGER NOT NULL,
  content_hash   TEXT,                        -- NULL only for deletion tombstones
  name           TEXT,                        -- subject / filename
  parent_path    TEXT,                        -- folder or drive path (restore layout)
  metadata       TEXT,                        -- JSON (from/to/sent_at/...)
  valid_from_run TEXT NOT NULL,
  valid_from_ts  INTEGER NOT NULL,            -- = run.started_at when first observed
  valid_to_run   TEXT,
  valid_to_ts    INTEGER,                     -- NULL = still current
  is_deleted     INTEGER NOT NULL DEFAULT 0,  -- tombstone: removed at source
  CHECK (is_deleted = 1 OR content_hash IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_versions_item   ON item_versions(item_uid);
CREATE INDEX IF NOT EXISTS idx_versions_run    ON item_versions(valid_from_run);
CREATE INDEX IF NOT EXISTS idx_versions_window ON item_versions(item_uid, valid_from_ts, valid_to_ts);
```

| Column                                               | Meaning                                                                                                                 |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `version_id`                                         | Auto-increment identity for the Version.                                                                                |
| `item_uid`                                           | The Item this Version belongs to.                                                                                       |
| `content_hash`                                       | The Blob's content address; `NULL` only for deletion Tombstones.                                                        |
| `name`                                               | Subject or filename.                                                                                                    |
| `parent_path`                                        | Folder or drive path, preserved for restore layout.                                                                     |
| `metadata`                                           | JSON sidecar (`from`/`to`/`sent_at`/...).                                                                               |
| `valid_from_run` / `valid_from_ts`                   | The Run that opened the Version and its `started_at` time anchor.                                                       |
| `valid_to_run` / `valid_to_ts`                       | The Run that closed the Version and the close time; `NULL` while current.                                               |
| `is_deleted`                                         | `1` for a Tombstone — the source deleted the Item.                                                                      |
| `CHECK (is_deleted = 1 OR content_hash IS NOT NULL)` | Content-bearing Versions must carry a Blob; only Tombstones may be blobless, so a deleted Item's Blob can be reclaimed. |

#### `idx_one_current_version`

The catalog's central integrity guard: a partial unique index allowing at most **one open (current) Version per Item**. This is what guarantees temporal consistency in place of foreign keys.

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_version
  ON item_versions(item_uid) WHERE valid_to_ts IS NULL;
```

A second partial index supports retention GC by indexing closed Versions:

```sql
CREATE INDEX IF NOT EXISTS idx_versions_closed
  ON item_versions(valid_to_ts) WHERE valid_to_ts IS NOT NULL;
```

### `current_items` view

The live state as of the most recent backup: it joins each Item to its single open Version (`valid_to_ts IS NULL`) and that Version's Blob, excluding Tombstones.

```sql
CREATE VIEW IF NOT EXISTS current_items AS
SELECT i.resource_key, i.graph_item_id, i.item_type,
       v.version_id, v.name, v.parent_path, v.metadata,
       b.r2_key, b.size
FROM items i
JOIN item_versions v ON v.item_uid = i.item_uid AND v.valid_to_ts IS NULL
JOIN blobs b         ON b.content_hash = v.content_hash
WHERE v.is_deleted = 0;
```

:::tip
A point-in-time restore is the same shape as `current_items` but with the open-Version predicate replaced by the validity-interval test `valid_from_ts <= T AND (valid_to_ts IS NULL OR valid_to_ts > T)`. See [the temporal model](/concepts/temporal-model/).
:::
