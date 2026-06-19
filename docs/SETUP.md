# Getting started / provisioning runbook

What must exist before an agent can build the MVP. Decisions live in `CONTEXT.md` and `docs/adr/0001–0004`; the work is filed as GitHub issues #2–#10. **Build order: #2 first** (per-tenant catalog), then the inner vertical slice (#3 + #5 + #7 + #8).

> The original `office365-handoff.md` predates the grilling session and is partly stale (e.g. "per-tenant OAuth refresh tokens" — we're app-only client-credentials now). Prefer this file + the ADRs.

## 1. Only you can do these (interactive / account-level)

- **Authenticate Wrangler:** `wrangler login` (or set `CLOUDFLARE_API_TOKEN`).
- **Register the multi-tenant Azure AD app** (ADR 0001): one app, multi-tenant. Create a client secret. Add **application** permissions `Mail.Read`, `Files.Read.All`, `User.Read.All` (MVP = mail + OneDrive; `Sites.*` deferred). Note the **Application (client) ID** and the **secret value**.
- **Onboard a test tenant** (manual, ADR 0004): grant admin consent in the test tenant; note its **directory (tenant) ID**.

## 2. Provision Cloudflare resources

```bash
pnpm install

wrangler r2 bucket create m365vault-blobs
wrangler queues create backup-queue
wrangler queues create backup-dlq
wrangler d1 create m365vault-control-plane     # control-plane registry (ADR 0003); note database_id
wrangler kv namespace create CONFIG            # note id

# Secrets Store: create a store and add the app secret (confirm 4.x syntax with --help)
wrangler secrets-store --help                  # then create store + secret `graph-app-secret`
```

Per-tenant **catalog** D1 databases are created at onboarding, not here (ADR 0003).

## 3. Wire it into `wrangler.jsonc`

Replace the placeholders with the IDs from step 2:

- `d1_databases[].database_id` ← control-plane DB id
- `kv_namespaces[].id` ← CONFIG id
- `secrets_store_secrets[].store_id` ← Secrets Store id
- Add the Azure **client id** as a plaintext `vars` entry (the app secret stays in Secrets Store); the single client id replaces the per-tenant KV lookup (#8).

Then: `pnpm cf-typegen` (regenerates `worker-configuration.d.ts` after binding changes).

## 4. Seed a test tenant row

Insert one row into the control-plane registry: tenant id (the test tenant GUID), display name, `backup_enabled = 1`, `retention_days`. (Exact location depends on how #2 implements the registry — KV vs control-plane D1.)

## 5. For the next agent

Read `CONTEXT.md`, `docs/adr/0001–0004`, and `gh issue list`, then start on **#2** — it unblocks the per-tenant catalog everything else writes to. #2 has one open implementation fork to settle first: per-tenant D1 (runtime-resolved) vs. catalog-in-the-`TenantCoordinator`-DO's-SQLite.
