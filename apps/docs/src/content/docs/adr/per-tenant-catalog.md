---
title: Per-tenant D1 catalog, per-tenant dedupe, ~300-mailbox v1 ceiling
description: Why each Tenant gets its own D1 catalog database, why dedupe is scoped per tenant, and why the v1 scale envelope is ~300 mailboxes per tenant.
---

## Decision

The catalog is **one D1 database per Tenant**, not a single shared database.

D1 caps a single database at **10 GB**, and one Tenant's catalog (an `items` row plus temporal `item_versions` rows per object, with ~150-byte Exchange immutable IDs) runs to tens of GB at full scale — a shared DB is impossible.

Per-tenant DBs also close an isolation hole: content-addressed dedupe (`blobs`) is scoped **per tenant**, so no Tenant's catalog ever references another Tenant's R2 objects.

## Context and considered options

- **Single shared D1** — rejected: exceeds the 10 GB cap, and global dedupe creates cross-tenant data dependencies (offboarding/GC in one Tenant corrupts another).
- **Intra-tenant sharding now** (hash resources across N DBs per Tenant) — deferred: unnecessary complexity for an MVP.

## Consequences

- The `tenants` registry moves to a small **control-plane** store (KV or a dedicated control-plane D1) that the cron reads.
- Every catalog query routes to the owning Tenant's database.
- **Cross-tenant dedupe savings are forgone** (the same attachment in two Tenants is stored twice) — the correct trade for isolation.
- The Q1 scale envelope is **amended from ~2,000 to ~300 mailboxes/tenant for v1**, so a Tenant's catalog fits one 10 GB DB with headroom (~6.6M items at ~1.2 KB each, less a churn/tombstone margin).
- Per-tenant DB size is monitored; a Tenant approaching ~8 GB is the trigger to build intra-tenant sharding (the deferred option).

:::note
This ~300-mailbox ceiling is the v1 scale envelope that the [MVP scope](/adr/mvp-scope/) capture-and-retention boundary references. The ~2,000-mailbox figure in the [Resource = delta collection](/adr/resource-equals-delta-collection/) record predates this amendment.
:::

## Related

- The `items`, `item_versions`, and `blobs` tables and their per-tenant scoping are described in [storage and the catalog](/architecture/storage-and-catalog/) and the [data model reference](/reference/data-model/).
- Content-addressed dedupe and `ref_count` are defined under Blob in the [domain glossary](/concepts/domain-glossary/).
- The temporal `[valid_from_ts, valid_to_ts)` Item Version model is covered in the [temporal model](/concepts/temporal-model/).
