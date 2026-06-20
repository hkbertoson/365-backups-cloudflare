---
title: Getting started
description: Provision the Cloudflare resources and Azure AD app that m365vault needs before its first backup run.
---

m365vault runs as a single Cloudflare Worker with a Workflow, a Queue consumer,
a per-tenant Durable Object, R2, and a small D1 control-plane registry. This page
is the provisioning runbook; the design rationale lives in the
[architecture overview](/architecture/overview/) and the
[architecture decision records](/adr/overview/).

## Prerequisites

- A Cloudflare account with Workers, R2, Queues, D1, and Durable Objects enabled.
- `wrangler` authenticated (`wrangler login`, or set `CLOUDFLARE_API_TOKEN`).
- A multi-tenant Azure AD app registration with **application** Graph
  permissions (`Mail.Read`, `Files.Read.All`, `User.Read.All`) and a client
  secret. Note the Application (client) ID and the secret value.

## 1. Provision Cloudflare resources

```bash
pnpm install

wrangler r2 bucket create m365vault-blobs
wrangler queues create backup-queue
wrangler queues create backup-dlq
wrangler d1 create m365vault-control-plane
```

Apply the control-plane migration and fill the placeholder ids in
`wrangler.jsonc` (the D1 `database_id`, the KV namespace id, and the Secrets
Store id):

```bash
wrangler d1 migrations apply m365vault-control-plane --remote
```

## 2. Store the Graph credentials

The shared app-registration secret lives in Secrets Store; each tenant's client
id lives in KV:

```bash
wrangler secret-store secret create graph-app-secret    # paste the client secret
wrangler kv key put graph:client_id:<tenant-guid> <application-client-id>
```

## 3. Onboard a tenant

Grant admin consent for the app in the target tenant, then register the tenant
in the control-plane registry so the daily cron picks it up:

```sql
INSERT INTO tenants (tenant_id, display_name, backup_enabled, retention_days, created_at, updated_at)
VALUES ('<tenant-guid>', 'Contoso', 1, 90, unixepoch() * 1000, unixepoch() * 1000);
```

## 4. Deploy

```bash
wrangler deploy
```

The daily cron (`0 3 * * *`) opens one backup Workflow per enabled tenant; the
weekly cron (`0 4 * * 0`) runs retention GC. See the
[backup workflow](/architecture/backup-workflow/) for what happens next.
