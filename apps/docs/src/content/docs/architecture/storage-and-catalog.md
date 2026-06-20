---
title: Storage and catalog
description: Content-addressed R2 blob storage plus the per-tenant temporal catalog that records every Item Version as a half-open validity interval.
---

m365vault separates **bytes** from **bookkeeping**. The bytes live in R2 as content-addressed Blobs; the bookkeeping lives in the Tenant's private SQLite catalog as a [temporal model](/concepts/temporal-model/) of Items and their Versions. The catalog is owned by the [TenantCoordinator](/architecture/tenant-coordinator/) DO; the full DDL is in `schema.ts` and the read/write functions in `catalog.ts`. See the [data model reference](/reference/data-model/) for every column.

## Content-addressed Blobs

A Blob is one stored R2 object, keyed by a **content address**. The `blobs` table maps that address to its R2 location and tracks how many Item Versions point at it:

```sql
CREATE TABLE blobs (
  content_hash TEXT PRIMARY KEY,   -- the content address
  r2_key       TEXT NOT NULL,      -- object key in R2 (BLOBS binding)
  size         INTEGER NOT NULL,
  ref_count    INTEGER NOT NULL DEFAULT 0,  -- # of item_versions pointing here
  created_at   INTEGER NOT NULL
);
```

`content_hash` is the primary key, so the same content maps to exactly one R2 object. `ref_count` is what makes garbage collection safe: a Blob is only reclaimable once no live Item Version references it (see [retention and restore](/architecture/retention-and-restore/)).

Insertion is an upsert that bumps the count on a dedupe hit:

```sql
INSERT INTO blobs (content_hash, r2_key, size, ref_count, created_at)
VALUES (?, ?, ?, 1, ?)
ON CONFLICT(content_hash) DO UPDATE SET ref_count = ref_count + 1;
```

### Two dedupe strategies

The content address is computed differently depending on the item, because the worker cannot always afford to buffer the whole object just to hash it:

- **Small drive files** (`size <= MULTIPART_THRESHOLD`, 8 MiB): the consumer buffers the bytes and computes a **true sha-256** of the content. This makes cross-mailbox and cross-run dedupe byte-exact — two identical attachments anywhere in the Tenant collapse to one Blob.
- **Large files and all mail**: the object is streamed straight into an R2 multipart upload and never fully buffered, so a byte hash is not available. Identity falls back to a Graph `etag:` surrogate (`etag:<item.version>`). Dedupe is version-keyed: an unchanged item has the same etag and is skipped, but two byte-identical large files with _different_ etags are stored twice.

The `content_hash` column is populated in both cases (true hash or `etag:` surrogate), so the `ref_count` and GC machinery is uniform across both paths and never has to special-case which strategy produced a Blob.

The R2 object key itself is `<tenantId>/<resourceKey>/<itemId>/<hash>`.

## The temporal upsert: `indexItem`

The catalog is bitemporal-lite: each Item Version is valid over the half-open interval `[valid_from_ts, valid_to_ts)`, and the open version (`valid_to_ts IS NULL`) is the current one. A partial unique index enforces **at most one open version per Item**:

```sql
CREATE UNIQUE INDEX idx_one_current_version
  ON item_versions(item_uid) WHERE valid_to_ts IS NULL;
```

`indexItem` performs the close-old / open-new transition in a single synchronous DO transaction. Because the DO SQL API is synchronous, there is no `await` between the read and the writes, and `transactionSync` rolls the whole thing back on any throw:

1. Read the Run's `started_at` — this is the temporal anchor `ts` for every timestamp the upsert writes.
2. Upsert the logical `items` row (one per real-world object) and bump `last_seen_run`.
3. Look up the open Version, capturing both its `content_hash` and its `version_id` (a Tombstone is an open Version with a `NULL` hash, so the id is needed to tell "no open version" from "open tombstone").
4. Decide:
   - **Deletion** (`item.isDeleted`): close the live Version and open a blobless [Tombstone](/concepts/temporal-model/) (`content_hash = NULL`, `is_deleted = 1`). The Tombstone holds no Blob reference, so once the now-closed content version expires the Blob drops to zero refs and becomes reclaimable.
   - **Hash unchanged** (`currentHash === contentHash`): nothing new to store; `last_seen_run` was already bumped, so return.
   - **Content changed or item reappeared**: close whatever is open (a prior content version _or_ a Tombstone), upsert the Blob (`ref_count + 1` on conflict), then insert a new open Version pointing at it.

Closing a Version stamps `valid_to_ts = ts` and `valid_to_run = runId`; opening one sets `valid_from_ts = ts`. Both endpoints come from the same Run anchor, so the new version's interval begins exactly where the old one ends — no gaps, no overlaps.

:::note
`openRun` forces each Run's `started_at` strictly past the previous Run's (`max(Date.now(), lastStartedAt + 1)`). Two Runs in the same millisecond would otherwise produce a zero-length `[valid_from, valid_to)` interval that point-in-time reads would skip.
:::

## Reading: point-in-time and `current_items`

The catalog answers two read shapes.

For **restore**, `pointInTime(runId, resourceKey)` resolves the Versions that were current at the instant of a given Run — the temporal selection that makes any past Restore Point recoverable:

```sql
WHERE r.run_id = ?
  AND v.valid_from_ts <= r.started_at
  AND (v.valid_to_ts IS NULL OR v.valid_to_ts > r.started_at)
  AND v.is_deleted = 0
```

It joins `runs` -> `items` -> `item_versions` -> `blobs`, filters to one Resource, and excludes Tombstones, returning each live Version's `r2_key` and `size` so the [restore path](/architecture/retention-and-restore/) can fetch and write back the bytes.

For **live state**, the `current_items` view selects the open Version of every Item as of the most recent backup:

```sql
CREATE VIEW current_items AS
SELECT i.resource_key, i.graph_item_id, i.item_type,
       v.version_id, v.name, v.parent_path, v.metadata, b.r2_key, b.size
FROM items i
JOIN item_versions v ON v.item_uid = i.item_uid AND v.valid_to_ts IS NULL
JOIN blobs b         ON b.content_hash = v.content_hash
WHERE v.is_deleted = 0;
```

## Run rollups

`finalizeRun` seals a Run (`status = completed`, `finished_at` set) and computes its rollups in one statement: `item_count` (versions opened this Run), `bytes_logical` (summed Item sizes, pre-dedupe), and `bytes_stored` (bytes actually written to R2 this Run, post-dedupe). The gap between the two is the dedupe savings.

The four tables — `runs`, `items`, `item_versions`, `blobs` — and the `current_items` view are documented column-by-column in the [data model reference](/reference/data-model/).
