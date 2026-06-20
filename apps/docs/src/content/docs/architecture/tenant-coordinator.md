---
title: TenantCoordinator
description: The per-tenant Durable Object that serializes Runs, owns the strongly-consistent Delta Cursors, governs the Graph rate budget, and holds the tenant's private SQLite catalog.
---

`TenantCoordinator` is the per-Tenant Durable Object. There is exactly one instance per Tenant, and it is the single point of strong consistency for everything that must be serialized for that Tenant: the run lease, the [Delta Cursors](/concepts/temporal-model/), the Graph rate budget, the outstanding-completion counter, and the Tenant's own SQLite catalog.

It is bound as `TENANT` in `wrangler.jsonc` (`class_name: "TenantCoordinator"`). Callers never construct an id by hand — they go through the typed `tenantStub` helper, which routes by name:

```ts
env.TENANT.get(env.TENANT.idFromName(tenantId)) as DurableObjectStub<TenantCoordinator>;
```

Because the DO is addressed by `idFromName(tenantId)`, the Tenant GUID _is_ the routing key. No registry lookup, no sharding logic — the same Tenant always lands on the same object, so its lease, cursors, token bucket, and catalog are all co-located and consistent for free.

All mutable state lives in `ctx.storage`, so it is strongly consistent and durable across DO restarts and relocations. `Date.now()` inside the DO reads the normal wall clock, so timestamps line up with the rest of the worker.

## The lease: one Run at a time

A Tenant may have at most one backup Run in flight. The lease enforces this:

```ts
async acquireLease(): Promise<{ acquired: boolean }> {
  const held = await this.ctx.storage.get<number>('lease');
  if (held && Date.now() - held < LEASE_TTL_MS) return { acquired: false };
  await this.ctx.storage.put('lease', Date.now());
  return { acquired: true };
}
```

The lease value is the wall-clock time it was taken. `LEASE_TTL_MS` is a 6-hour safety net: if a Run dies without calling `releaseLease`, the lease self-expires so the next scheduled Run is not blocked forever. A healthy Run releases the lease explicitly when it finalizes.

:::note
The lease is a coarse mutual-exclusion guard at the Run boundary, not a fine-grained lock around each catalog write. Catalog atomicity is handled separately by synchronous SQL transactions — see [storage and catalog](/architecture/storage-and-catalog/).
:::

## Delta Cursors: the incremental-backup memory

Each Resource (one mail folder or one drive) has exactly one [Delta Cursor](/concepts/temporal-model/) — the Graph `deltaLink` that records how far incremental sync has progressed. The cursors are held here, in DO storage, under `cursor:<resourceKey>` keys, so they are strongly consistent and survive restarts:

```ts
async getCursor(key: string): Promise<string | null> {
  return (await this.ctx.storage.get<string>(`cursor:${key}`)) ?? null;
}
async setCursor(key: string, deltaLink: string | null): Promise<void> {
  if (deltaLink === null) await this.ctx.storage.delete(`cursor:${key}`);
  else await this.ctx.storage.put(`cursor:${key}`, deltaLink);
}
```

`setCursor(key, null)` deletes the cursor, which forces a **full resync** of that Resource on the next page: with no stored `deltaLink`, the next [queue consumer](/architecture/queue-consumer/) delta call starts from scratch. The consumer uses this deliberately — when Graph reports the delta token is expired or invalid, it calls `setCursor(key, null)` and retries, and the Resource reseeds cleanly.

The `resource_key` is `"<kind>:<graph_id>"`, except mail folders, which are `"mailfolder:<ownerId>:<folderId>"` because folder ids are mailbox-scoped rather than tenant-unique. The same key is used as the cursor key, the catalog `resource_key`, and a fragment of the blob key, so it must be unique tenant-wide.

## The rate governor: a token bucket

Microsoft Graph throttles per tenant and per service. The coordinator owns a single token bucket per Tenant so that all concurrent backup work for that Tenant draws from one shared, serialized budget:

```ts
static CAP = 30;            // allowed burst
static REFILL_PER_SEC = 8;  // steady-state rate
```

`takeToken()` lazily refills the bucket from the elapsed time since the last call, then either spends a token and returns `0` (go now), or, if fewer than one token is available, returns the number of **milliseconds to wait** before a token will be ready:

```ts
async takeToken(): Promise<number> {
  const now = Date.now();
  const bucket = (await this.ctx.storage.get('bucket')) ?? { tokens: CAP, ts: now };
  const tokens = Math.min(CAP, bucket.tokens + ((now - bucket.ts) / 1000) * REFILL_PER_SEC);
  if (tokens >= 1) { /* spend one, return 0 */ }
  // else persist the partial bucket and return ms-to-wait
}
```

The consumer spends a token _before_ every Graph call. A non-zero return is flow control, not failure — under heavy fan-out a denial is the common case, and the consumer reacts by re-enqueuing a fresh copy of the job with a jittered delay rather than charging it against the queue's retry budget. See the [queue consumer](/architecture/queue-consumer/) for how token denial is decoupled from retries.

`CAP` and `REFILL_PER_SEC` are static class fields, tuned to Graph's per-tenant throttling envelope: `CAP` is the burst you can spend at once, `REFILL_PER_SEC` the sustained rate.

## Outstanding-completion counter

A Run fans out into one queue message per Resource page, and the coordinator tracks completion at the **Resource** level, not the page level:

```ts
async setOutstanding(n: number): Promise<void>   // armed with the resource count
async decrOutstanding(): Promise<number>          // ticked when a resource fully syncs
async outstanding(): Promise<number>
```

The Run arms the counter with the total number of Resources. The consumer only calls `decrOutstanding()` when a Resource is _fully_ synced — i.e. the delta has no more pages and its new cursor has been saved. Intermediate pages re-enqueue themselves and do **not** tick the counter. When the count reaches zero, every Resource has been captured and the Run can be finalized.

## The Tenant's private catalog

The catalog — `runs`, `items`, `item_versions`, `blobs`, and the `current_items` view — lives in _this DO's own SQLite_, not in a shared D1 database (see [ADR: per-tenant catalog](/adr/per-tenant-catalog/)). The DO boundary _is_ the Tenant, so the catalog tables carry no `tenant_id` column. Dedupe is per-tenant by construction, because each Tenant has its own `blobs` table.

The schema is applied once in the constructor, inside `blockConcurrencyWhile`, before any request is served. Every statement is `CREATE ... IF NOT EXISTS`, so it is a no-op after first start:

```ts
constructor(ctx, env) {
  super(ctx, env);
  ctx.blockConcurrencyWhile(async () => {
    ctx.storage.sql.exec(CATALOG_SCHEMA);
  });
}
```

The coordinator exposes the catalog as RPC methods that thin-wrap the functions in `catalog.ts`, passing through `this.ctx.storage`:

| RPC method                                     | Purpose                                                       |
| ---------------------------------------------- | ------------------------------------------------------------- |
| `openRun(kind, totalResources, retentionDays)` | Open a `running` Run row; returns the `run_id`                |
| `finalizeRun(runId)`                           | Seal the Run: `status = completed`, compute rollups           |
| `blobExists(contentHash)`                      | Dedupe pre-check; returns the existing `r2_key` or null       |
| `indexItem(input)`                             | The atomic temporal upsert (close-old / open-new version)     |
| `pointInTime(runId, resourceKey)`              | Restore read: versions live at the Run's anchor               |
| `expireVersions(cutoff, limit)`                | One retention page: expire closed versions, return dead blobs |
| `removeBlobs(hashes)`                          | Drop catalog rows for blobs the caller deleted from R2        |

Because the DO SQL API is synchronous, each of these runs its read-then-decide-then-write sequence with no `await` in between, and the mutating ones wrap the whole sequence in `ctx.storage.transactionSync(...)`. How those reads and writes are shaped — the temporal upsert, content-addressed blobs, point-in-time reads — is covered in [storage and catalog](/architecture/storage-and-catalog/).
