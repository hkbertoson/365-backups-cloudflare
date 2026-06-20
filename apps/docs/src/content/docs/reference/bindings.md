---
title: Bindings
description: Reference for every Cloudflare resource binding and cron trigger the m365vault Worker declares in wrangler.jsonc.
---

The Worker declares its runtime dependencies as bindings in `wrangler.jsonc`. Each binding name below is the property exposed on the `Env` object inside the Worker. After changing any binding, regenerate types with `npx wrangler types`.

For how these pieces fit together at runtime, see the [architecture overview](/architecture/overview/). For the operational tuning of crons, retention, and rate limits, see [configuration](/reference/configuration/).

## Bindings

| Binding            | Cloudflare resource                                  | Purpose                                                                                                                                                                                                                                               |
| ------------------ | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BACKUP_WORKFLOW`  | Workflow (`backup-workflow`, class `BackupWorkflow`) | The per-Run orchestration brain. Durable and resumable; one instance is started per Tenant each daily Run to discover scope, fan out jobs, and finalize the Restore Point.                                                                            |
| `TENANT`           | Durable Object (`TenantCoordinator`)                 | The per-Tenant coordinator routed via `idFromName(tenantId)`. Serializes Runs with a lease, owns the strongly-consistent Delta Cursors, runs the token-bucket rate governor, tracks Run completion, and holds the Tenant's catalog in its own SQLite. |
| `BACKUP_QUEUE`     | Queue producer (`backup-queue`)                      | The fan-out queue. The Workflow enqueues one message per Resource page (`BackupJob`); the consumer downloads bytes and writes to the catalog.                                                                                                         |
| `backup-dlq`       | Queue (dead-letter for `backup-queue`)               | Catches poison messages that exhaust their retries so a single bad Item cannot stall the queue.                                                                                                                                                       |
| `BLOBS`            | R2 bucket (`m365vault-blobs`)                        | Content-addressed object store for the actual bytes — MIME messages, files, attachments. One content address maps to one R2 object.                                                                                                                   |
| `DB`               | D1 (`m365vault-control-plane`)                       | The control-plane registry. Holds only the `tenants` table; the cron reads it to decide which Tenants to back up. The per-Tenant catalog lives in each `TenantCoordinator` DO, not here (ADR 0003).                                                   |
| `CONFIG`           | KV namespace                                         | Per-Tenant config, feature flags, and hot lookups. Eventually consistent — not used for anything requiring strong consistency.                                                                                                                        |
| `GRAPH_APP_SECRET` | Secrets Store (`graph-app-secret`)                   | The app-registration secret used to authenticate to Microsoft Graph, plus per-Tenant OAuth tokens, stored encrypted.                                                                                                                                  |

:::note
The `DB`, `CONFIG`, and `GRAPH_APP_SECRET` bindings carry `REPLACE_WITH_...` placeholder IDs in `wrangler.jsonc`. These must be filled with the real D1 database id, KV namespace id, and Secrets Store id before deploying.
:::

## Queue consumer settings

The `backup-queue` consumer is configured for the flow-control model described in [the queue consumer](/architecture/queue-consumer/):

| Setting             | Value        | Why                                                                                                                                                                             |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `max_batch_size`    | `10`         | Messages delivered per consumer invocation.                                                                                                                                     |
| `max_batch_timeout` | `5`          | Seconds to wait before delivering a partial batch.                                                                                                                              |
| `max_retries`       | `25`         | A high ceiling, because token-denial flow-control re-enqueues a _fresh_ message rather than retrying. Retries are reserved for genuine errors before a message reaches the DLQ. |
| `max_concurrency`   | `10`         | Bounds the re-send herd well under the 5,000 msg/s/queue platform ceiling.                                                                                                      |
| `dead_letter_queue` | `backup-dlq` | Destination for messages that exhaust `max_retries`.                                                                                                                            |

## Cron triggers

The Worker declares two cron triggers under `triggers.crons`:

| Schedule    | Purpose                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------- |
| `0 3 * * *` | Daily backup. The cron handler reads `tenants` from D1 and starts a `BackupWorkflow` for each enabled Tenant. |
| `0 4 * * 0` | Weekly retention / GC sweep. Expires Item Versions past their cutoff and reclaims unreferenced Blobs.         |

Both schedules and the registry fields that gate them are documented in [configuration](/reference/configuration/).

## Other top-level config

- `nodejs_compat` is enabled via `compatibility_flags`, with `compatibility_date` `2026-06-18`.
- `observability.enabled` is `true` with `head_sampling_rate` `1` (full sampling).
- `upload_source_maps` is `true` so stack traces map back to source.
- The DO migration tag `v1` registers `TenantCoordinator` as a `new_sqlite_class`, which is what gives each DO its embedded SQLite catalog.
