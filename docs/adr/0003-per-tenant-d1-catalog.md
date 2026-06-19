# Per-tenant D1 catalog, per-tenant dedupe, ~300-mailbox v1 ceiling

The catalog is **one D1 database per tenant**, not a single shared database. D1 caps a single database at **10 GB**, and one tenant's catalog (an `items` row + temporal `item_versions` rows per object, with ~150-byte Exchange immutable IDs) runs to tens of GB at full scale — a shared DB is impossible. Per-tenant DBs also close an isolation hole: content-addressed dedupe (`blobs`) is scoped **per tenant**, so no tenant's catalog ever references another tenant's R2 objects.

## Considered Options

- **Single shared D1** — rejected: exceeds the 10 GB cap, and global dedupe creates cross-tenant data dependencies (offboarding/GC in one tenant corrupts another).
- **Intra-tenant sharding now** (hash resources across N DBs per tenant) — deferred: unnecessary complexity for an MVP.

## Consequences

- The `tenants` registry moves to a small **control-plane** store (KV or a dedicated control-plane D1) that the cron reads.
- Every catalog query routes to the owning tenant's database.
- **Cross-tenant dedupe savings are forgone** (the same attachment in two tenants is stored twice) — the correct trade for isolation.
- The Q1 scale envelope is **amended from ~2,000 to ~300 mailboxes/tenant for v1**, so a tenant's catalog fits one 10 GB DB with headroom (~6.6M items at ~1.2 KB each, less a churn/tombstone margin).
- Per-tenant DB size is monitored; a tenant approaching ~8 GB is the trigger to build intra-tenant sharding (the deferred option).
