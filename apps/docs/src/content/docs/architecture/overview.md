---
title: Architecture overview
description: How m365vault turns a daily cron into per-tenant restore points — Workflows discover scope, a Queue fans out per-Resource jobs, and consumers pull Microsoft Graph into R2 and the catalog.
---

m365vault is a single Cloudflare Worker that backs up Microsoft 365 Tenants
to Cloudflare's edge. On a schedule it pulls each Tenant's mail folders and
drives from Microsoft Graph, content-addresses the bytes into R2, and records
a temporal catalog so any [Item](/concepts/domain-glossary/) can be restored
as it existed at any past [Run](/concepts/domain-glossary/). This page is the
end-to-end system map; each component has its own page linked below.

## The two crons

The Worker's `scheduled` handler is driven by two cron triggers declared in
`wrangler.jsonc`:

- **Daily backup — `0 3 * * *`.** Reads the control-plane registry
  (`SELECT tenant_id FROM tenants WHERE backup_enabled = 1`) and calls
  `env.BACKUP_WORKFLOW.create({ params: { tenantId } })` once per enabled
  Tenant. Each `create` starts one independent, durable
  [BackupWorkflow](/architecture/backup-workflow/) instance.
- **Weekly retention GC — `0 4 * * 0`.** Routed to `runRetention(env)`, which
  expires [Item Versions](/concepts/domain-glossary/) past each Tenant's
  `retention_days` and reclaims the [Blobs](/concepts/domain-glossary/) whose
  `ref_count` has dropped to zero. See
  [retention and restore](/architecture/retention-and-restore/).

The handler branches on `controller.cron`: the retention cron returns early
after GC, everything else is treated as the daily backup pass.

## The flow of one backup Run

```text
daily cron ─▶ BackupWorkflow (one per Tenant)
                 │  acquire lease, discover scope (Resources)
                 │  open Run, prime counter
                 ▼
            BACKUP_QUEUE ──▶ queue consumer (one msg == one page of one Resource)
                 ▲   │            │  spend rate token (TenantCoordinator)
       nextLink ─┘   │            │  Graph delta page ─▶ R2 (bytes) + catalog (index)
                     │            ▼
                     └── deltaLink: advance Delta Cursor + decrement counter
                 │
            await-drain (counter ▶ 0) ─▶ finalize Run ─▶ release lease
```

1. **Discover.** The [BackupWorkflow](/architecture/backup-workflow/) acquires
   a per-Tenant lease (one Run at a time), then expands the Tenant's
   [Scope Containers](/concepts/domain-glossary/) into
   [Resources](/concepts/domain-glossary/): each user's mailbox becomes its
   mail-folder tree, each user gets their OneDrive drive, and sites contribute
   their document-library drive. A Resource is exactly one delta-trackable
   collection — a mail folder or a drive.

2. **Fan out.** The Workflow opens a Run in the catalog, primes the completion
   counter to the number of Resources, and sends one message per Resource to
   `BACKUP_QUEUE`. A 300-mailbox Tenant expands to tens of thousands of
   Resources — large fan-out is deliberate (see
   [Resource = delta collection](/adr/resource-equals-delta-collection/)).

3. **Capture.** The [queue consumer](/architecture/queue-consumer/) pulls one
   delta page per message. It spends a rate token from the Tenant's governor,
   fetches the page from Graph, writes new bytes to R2, and indexes each Item
   into the catalog. A `nextLink` re-enqueues the next page; a `deltaLink`
   advances the [Delta Cursor](/concepts/domain-glossary/) and decrements the
   counter.

4. **Finalize.** The Workflow polls the outstanding counter, sleeping cheaply
   between checks. When it reaches zero, every Resource has drained; the
   Workflow finalizes the Run (sealing the [Restore Point](/concepts/domain-glossary/))
   and releases the lease.

## Components

| Component             | Binding            | Role                                                                                                                                                                                                                                                       |
| --------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **BackupWorkflow**    | `BACKUP_WORKFLOW`  | Per-Run orchestration brain — durable and resumable; one instance per Tenant per day. See [backup workflow](/architecture/backup-workflow/).                                                                                                               |
| **Queue + DLQ**       | `BACKUP_QUEUE`     | Fan-out transport: one message per Resource page. Poison messages dead-letter to `backup-dlq`. See [queue consumer](/architecture/queue-consumer/).                                                                                                        |
| **TenantCoordinator** | `TENANT`           | Per-Tenant Durable Object: serializes Runs (lease), owns Delta Cursors, runs the token-bucket rate governor, tracks the completion counter, and holds the Tenant's catalog in its own SQLite. See [tenant coordinator](/architecture/tenant-coordinator/). |
| **R2**                | `BLOBS`            | Content-addressed Blob store (`m365vault-blobs`) — the actual MIME, files, and attachments. See [storage and catalog](/architecture/storage-and-catalog/).                                                                                                 |
| **D1 control plane**  | `DB`               | The `tenants` registry only — display name, `backup_enabled`, `retention_days`. The cron reads it; the per-Tenant catalog lives in the DO, not here.                                                                                                       |
| **KV**                | `CONFIG`           | Per-Tenant config and hot lookups (eventually consistent).                                                                                                                                                                                                 |
| **Secrets Store**     | `GRAPH_APP_SECRET` | The shared multi-tenant Azure AD app secret, used for app-only client-credentials auth to Graph.                                                                                                                                                           |

:::note
The control-plane D1 (`DB`) and the per-Tenant catalog are different stores.
`DB` holds only the `tenants` registry the cron iterates; each Tenant's catalog
(`runs`, `items`, `item_versions`, `blobs`) lives in its `TenantCoordinator`
DO SQLite, so one Tenant's catalog can never reference another Tenant's R2
objects. This per-Tenant isolation is recorded in
[per-tenant catalog](/adr/per-tenant-catalog/).
:::

## Why this shape

- **One Worker, many bindings.** A single deployment owns the cron, the
  Workflow class, the Durable Object class, and the queue consumer — the
  `scheduled`, `queue`, and `fetch` handlers all live in `src/index.ts`.
- **Durable orchestration, stateless capture.** The Workflow is the only
  stateful, long-running actor; every queue message is a uniform "sync one
  Resource from one cursor" unit that re-enqueues its own continuation.
- **Per-Tenant governance.** Rate limiting, lease serialization, and the
  catalog are all scoped to the `TenantCoordinator`, routed for free by
  `idFromName(tenantId)`, so Tenants never contend.

For the precise vocabulary used throughout — Tenant, Scope Container, Resource,
Run, Restore Point, Item, Item Version, Blob, Delta Cursor, Seed, Tombstone —
see the [domain glossary](/concepts/domain-glossary/).
