---
title: Retention and restore
description: The reverse paths — weekly retention GC that reclaims zero-ref Blobs, and point-in-time restore that writes a Restore Point's Item Versions back through Graph.
---

Capture is only half the engine. The two reverse paths are **retention** (reclaim storage past the retention window) and **restore** (write a past Restore Point back to Microsoft 365). Both read the temporal catalog described in [storage and catalog](/architecture/storage-and-catalog/); their reasoning is grounded in the [temporal model](/concepts/temporal-model/).

## Retention: scheduled garbage collection

Retention runs on a weekly cron and processes one Tenant at a time. The Tenant list and each Tenant's `retention_days` come from the control-plane `tenants` registry in the `DB` (D1) binding — _not_ from the per-Tenant catalog, which carries no retention policy. The actual expiry runs inside each Tenant's [TenantCoordinator](/architecture/tenant-coordinator/) DO, where there is no D1 per-invocation query cap to fight.

`runRetention` walks the registry (`SELECT tenant_id, retention_days FROM tenants WHERE backup_enabled = 1`), computes a cutoff of `Date.now() - retention_days * DAY_MS` per Tenant, and pages through `gcTenant`.

### The two-phase delete

Each page calls the DO's `expireVersions(cutoff, PAGE)` (PAGE = 500). Inside one `transactionSync`, the DO:

1. Selects closed Versions whose `valid_to_ts < cutoff` (closed, and past the window — open versions are never expired).
2. For each, decrements its Blob's `ref_count` and deletes the Version row.
3. Returns up to `limit` **zero-ref Blob candidates** (`content_hash`, `r2_key`, `size`) — but does **not** delete the Blob rows.

The Blob rows are left in place deliberately. The caller deletes the R2 object _first_, then calls `removeBlobs(deleted)` to drop only the rows whose objects it actually removed. This ordering means the catalog can never reference an R2 object that is already gone, and never orphans an R2 object whose row was dropped:

```ts
for (const b of dead) {
	try {
		await env.BLOBS.delete(b.r2_key);
	} catch {
		continue; // Object Lock window — leave the blob row in place
	}
	deleted.push(b.content_hash);
}
await coordinator.removeBlobs(deleted);
```

:::caution Object-Lock tolerant
R2 Object Lock can enforce an independent immutability floor that outlasts the retention window. A delete inside that locked window throws; the loop catches it, skips that Blob, and leaves both the R2 object _and_ its catalog row in place. The Blob simply becomes a GC candidate again on the next pass once the lock lifts — the catalog never points at a missing object, and a still-present object is never silently dropped from the catalog.
:::

`gcTenant` loops until a page returns fewer than `PAGE` expired versions, accumulating `versionsExpired`, `blobsDeleted`, and `bytesReclaimed` into the `RetentionResult`.

## Restore: point-in-time write-back

Restore resolves a Restore Point and replays its live state back into the Tenant. The caller supplies a `runId` (the Restore Point) and a `resourceKey`; the Run's `started_at` is the time anchor the query resolves against.

`restore` calls the DO's `pointInTime(runId, resourceKey)` to get the Item Versions that were current at that instant (Tombstones excluded — a deleted item is not re-created). For each row it:

1. Fetches the Blob from R2 by `r2_key` (`env.BLOBS.get`).
2. Reconstructs a `BackupItem` from the row's `name`, `parent_path`, and JSON `metadata`.
3. Writes it back through Graph (`graph.writeBack`), streaming the R2 body for large blobs (`size > 8 MiB`) and buffering small ones.

```ts
const results = await coordinator.pointInTime(params.runId, params.resourceKey);
for (const row of results) {
	const blob = await env.BLOBS.get(row.r2_key);
	const body = row.size > 8 * 1024 * 1024 ? blob.body : await blob.arrayBuffer();
	await graph.writeBack(params.tenantId, params.resourceKey, rowToItem(row), body);
}
```

### Failure handling

Restore tallies, it does not abort. A per-item failure (a Graph conflict, throttling, a permission error) increments `itemsFailed` and the loop continues. A row that references a Blob already gone from R2 — a GC bug, or a locked object deleted out of band — also counts as failed rather than crashing the run. The result is `{ itemsRestored, itemsFailed }`.

### Documented fidelity gaps

Restoring _bytes_ is straightforward; restoring _fidelity_ is the hard half, and the baseline is honest about what it does not yet do:

- **No partial-restore resume cursor** — a failed item is counted, not retried; a repair/retry pass is future work.
- **Fidelity surface** — permissions, version history, folder placement, immutable ids, and conflict handling are the difficult parts of write-back; the gaps are documented at the `graph.writeBack` call site.

The restore loop here drives the iteration and counts the outcomes; closing the fidelity gaps lives behind the Graph write-back boundary.
