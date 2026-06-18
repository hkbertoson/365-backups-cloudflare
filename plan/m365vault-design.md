# m365vault — Design Summary

A Microsoft 365 backup engine built on Cloudflare. The server's job is narrow: pull tenant data from Microsoft Graph on a schedule, store the bytes durably, keep a searchable catalog, and be able to restore any item to any point in time. Everything below is design intent, not yet built.

## Architecture at a glance

The platform fits this problem well because the work is I/O-bound fan-out, the jobs are long-running, and storage is cheap. Each Cloudflare primitive gets one clear job:

- **R2** — the foundation. Holds the actual bytes (emails as MIME, OneDrive/SharePoint files, attachments). Zero egress fees make restores cheap, and Object Lock (WORM) gives ransomware/compliance immutability. This is the only place irreplaceable data lives.
- **Workflows** — the per-run orchestration brain. One durable, resumable Workflow instance per tenant backup run. Survives crashes and resumes from the last checkpoint, which is essential for the multi-hour initial "seed" backup.
- **Durable Object (per tenant)** — coordinator and rate governor. Serializes runs (one at a time per tenant via a lease), owns the strongly-consistent delta cursors, and runs the token-bucket rate limiter that keeps Graph from throttling us into the ground. Also tracks run completion.
- **Queues** — work distribution and the throttle valve. Fan out one job per mailbox / drive / site (and per delta page). Consumer concurrency is the lever that keeps us under Graph's limits; dead-letter queue catches poison items.
- **D1** — the catalog/index over the R2 blob store. Metadata, version chains, restore points, run history. Makes granular and point-in-time restore queryable.
- **KV** — per-tenant config, feature flags, hot lookups. Nothing authoritative (eventually consistent).
- **Secrets Store** — the app-registration secret; per-tenant OAuth refresh tokens stored encrypted.
- **Cron Triggers** — wake the scheduled runs, which simply start Workflows.

## Backup run flow

1. Cron starts a Workflow per enabled tenant.
2. The Workflow takes a lease and reads delta cursors from the tenant Durable Object.
3. It discovers scope (mailboxes, drives, sites) and primes a completion counter = number of resources.
4. It fans out one Queue job per resource.
5. Consumers spend a rate token, pull a delta page from Graph, stream bytes to R2 (multipart for large items), and write index rows to D1. More pages re-enqueue themselves; the last page advances the delta cursor and ticks the counter down.
6. When the counter hits zero, the Workflow seals the restore point and releases the lease.

## Data model

The catalog uses a **temporal model** rather than snapshotting the whole vault per run. Each content state of an item carries a `[valid_from_ts, valid_to_ts)` validity interval; a new content hash closes the old version and opens a new one. Point-in-time restore is then a query for the version whose interval contains a given run's `started_at` — which reconstructs the true state at that instant, not merely the items that changed in that run.

Key tables: `tenants`, `resources`, `runs` (each run is a restore point), `items` (logical identity), `item_versions` (temporal content states), and `blobs`.

Two choices that matter:

- **Content-addressed dedupe** (`blobs` table). Item versions reference a `content_hash`, not an R2 key directly, so an unchanged file across nightly runs — or the same attachment across many mailboxes — is stored in R2 once. `ref_count` makes retention GC safe. This is what keeps storage economical at TB scale.
- **Enforced single-current-version invariant.** A SQLite partial unique index guarantees at most one open version per item, so a buggy write fails loudly instead of silently corrupting the timeline.

Retention/GC is a scheduled job: expire old closed versions, decrement blob `ref_count`, delete R2 objects at zero refs. R2 Object Lock enforces an immutability floor independently, so GC can't delete inside the locked window.

## Restore

The reverse path: read the D1 index for the chosen restore point, fetch the referenced blobs from R2, and write them back through Graph (requires write scopes). Restore is the harder half of the product — granular fidelity (re-injecting an email, restoring a file with version history and permissions) is where most of the value and support load lives. Design the restore path and its permission model early rather than bolting it on.

## The hard parts (none are the Cloudflare wiring)

- **Microsoft Graph throttling is the dominant constraint** — per app, per tenant, and per service (Exchange/SharePoint each have their own limits), surfaced as 429 + `Retry-After`. The whole Queue-concurrency + DO-token-bucket design exists to dance within these limits.
- **Worker runtime limits vs. large files** — no single invocation can stream a 10 GB file. Everything decomposes into small, resumable, ranged chunks written as R2 multipart uploads. This is _why_ the design is queue-and-checkpoint shaped.
- **Delta cursor lifecycle** — tokens expire and occasionally invalidate; you need a clean full-resync fallback or you get silent gaps.
- **Restore fidelity** — see above.
- **Immutability & retention** — Object Lock, legal hold, and enough separation that a compromised live tenant can't poison the backups.

## Suggested build order

Prove the inner vertical slice first, before any orchestration: the per-tenant Durable Object plus a single consumer that pulls one mailbox's delta pages into R2 and writes the D1 index, with the token bucket and 429 handling working end to end. That slice contains all the real risk (Graph auth, throttling, streaming large items, cursor handling). Wrapping it in a Workflow and fanning out to N resources is comparatively mechanical afterward.

## Artifacts from this session

- `m365-backup-architecture.svg` — architecture overview diagram.
- `m365vault-skeleton.ts` — pseudocode skeleton (cron, Workflow, Durable Object coordinator/rate-governor, queue consumer, Graph client, restore sketch).
- `m365vault-schema.sql` — D1 catalog schema with the temporal versioning model, content-addressed dedupe, and the point-in-time restore query.

## Open next steps

- The real `indexItem` transaction in TypeScript (atomic close-old / open-new).
- The retention/GC job.
- `wrangler.jsonc` wiring all bindings together.
