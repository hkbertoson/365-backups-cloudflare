---
title: Temporal model
description: How Item Versions model time with half-open validity intervals, the one-open-version-per-item invariant, tombstones, and Run-anchored point-in-time restore.
---

m365vault is a temporal database in miniature: every backed-up object keeps its
full content history, and any Run can be restored to the exact state the Tenant
was in at that Run's `started_at`. This page explains the time model that makes
that possible. The terms used here — Item, Item Version, Run, Restore Point,
Tombstone, Blob — are defined in the
[domain glossary](/concepts/domain-glossary/).

## Three tables, one timeline

The model lives in three catalog tables inside each Tenant's
`TenantCoordinator` Durable Object SQLite (see
[storage and the catalog](/architecture/storage-and-catalog/)):

- **`items`** — the stable logical identity of one object, keyed by
  `(resource_key, graph_item_id)` with an internal `item_uid`. It never changes
  when content changes.
- **`item_versions`** — one row per observed content state of an Item, each
  carrying a validity interval. This is where time lives.
- **`blobs`** — content-addressed R2 objects; each Item Version with content
  points at one via `content_hash`.

## The half-open validity interval

Each Item Version is valid over the **half-open interval**
`[valid_from_ts, valid_to_ts)` — inclusive of `valid_from_ts`, exclusive of
`valid_to_ts`. Both timestamps are INTEGER epoch-ms.

- `valid_from_ts` is set to the `started_at` of the Run that first observed this
  content state.
- `valid_to_ts` is `NULL` while the version is still current, and is set to a
  later Run's `started_at` when a newer version closes it.

```sql
-- item_versions (abridged from src/schema.ts)
valid_from_ts  INTEGER NOT NULL,   -- = run.started_at when first observed
valid_to_ts    INTEGER,            -- NULL = still current
is_deleted     INTEGER NOT NULL DEFAULT 0
```

Half-open intervals tile the timeline with no gaps and no overlaps: when version
A closes at time `T`, version B opens at the _same_ `T`, so a point-in-time read
at exactly `T` matches B (because `valid_from_ts <= T`) and not A (because
`valid_to_ts = T` is excluded). This is why `started_at` is forced strictly past
the previous Run's `started_at` — two Runs sharing a millisecond would produce a
zero-length interval `[T, T)` that no read could ever land inside.

## `valid_to_ts IS NULL` means current

The open version is, by definition, the row with `valid_to_ts IS NULL`. There is
no separate "is current" flag; currentness is encoded directly in the interval.
The `current_items` view is just the join of every Item to its open, non-deleted
version:

```sql
JOIN item_versions v ON v.item_uid = i.item_uid AND v.valid_to_ts IS NULL
```

## Invariant: at most one open version per Item

The integrity guarantee of the whole model is enforced by a **partial unique
index**, not a foreign key:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_current_version
  ON item_versions(item_uid) WHERE valid_to_ts IS NULL;
```

An Item can have many closed versions but never two open ones. The temporal
upsert in `indexItem` upholds this by always closing the open version (a prior
content version _or_ a tombstone) before inserting a new one, all inside a single
synchronous `transactionSync` that rolls back on any throw. Because the DO SQL
API is synchronous, the read-then-decide and the writes run with no `await`
between them, so the close-old / open-new pair is atomic.

## Tombstones close the timeline on deletion

When Graph reports an Item as deleted, m365vault does **not** delete catalog
rows. It writes a **Tombstone**: it closes the currently-open content version
(stamping its `valid_to_ts`) and inserts a new open version with
`is_deleted = 1` and a `NULL` content_hash. The schema allows a null content
hash only for tombstones:

```sql
CHECK (is_deleted = 1 OR content_hash IS NOT NULL)
```

Because the tombstone carries no Blob reference, the deleted item still holds an
open version (so re-observing it later correctly closes the tombstone and opens
a fresh content version), while its old content Blob loses a reference once the
closed version expires under retention. Point-in-time reads exclude tombstones
(`v.is_deleted = 0`), so a deleted item simply stops appearing in Runs after the
one that recorded its deletion — yet it remains restorable from any earlier Run.

## A Run's `started_at` anchors point-in-time restore

A **Run is a Restore Point**: its `started_at` (call it `T`) is the single time
anchor for reconstructing the Tenant. To restore "as of Run R", m365vault selects
every Item Version whose interval contains `R.started_at`:

```sql
-- POINT_IN_TIME_QUERY (from src/catalog.ts)
WHERE r.run_id = ?
  AND v.valid_from_ts <= r.started_at
  AND (v.valid_to_ts IS NULL OR v.valid_to_ts > r.started_at)
  AND v.is_deleted = 0
```

Each surviving version joins to its Blob's `r2_key`, giving the exact bytes that
were current at `T`. Because intervals tile the timeline cleanly, exactly one
version of each then-live Item matches, and the result is the Tenant's recoverable
state at that instant. See
[retention and restore](/architecture/retention-and-restore/) for how this query
drives recovery and how expired closed versions are garbage-collected without
ever orphaning a live Blob.

:::tip
You can restore to _any_ completed Run, not just the latest — the timeline is
fully preserved. The only thing that removes history is retention GC expiring
versions whose `valid_to_ts` is older than the cutoff.
:::
