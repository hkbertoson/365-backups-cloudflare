# Handoff — Issue #2 complete (per-tenant catalog), pending commit

## TL;DR

Issue **#2** (per-tenant D1 catalog: control-plane registry + per-tenant DB routing + per-tenant dedupe) is **implemented, tested, and green** — but **not committed**, and it's sitting on the **wrong branch** (`chore/setup-pre-commit`). Switch branches, commit, then start the inner vertical slice.

## Git state / how to commit

- Current branch: `chore/setup-pre-commit` (3 commits ahead of `main`; includes the husky/lint-staged/oxfmt/oxlint pre-commit setup).
- **Nothing this session is committed.** The whole working tree is uncommitted — my #2 work **plus** a large pre-existing scaffold that was already untracked at session start (`CONTEXT.md`, `docs/`, `migrations/`, most of `src/`, `plan/`, `office365-handoff.md`).
- First, create the feature branch (uncommitted changes carry over):
  ```
  git switch -c feat/per-tenant-catalog
  ```

### Option A — one commit (simplest)

`git add -A && git commit`. One "app scaffold + #2" commit. Accurate, since it's all first-time WIP.

### Option B — keep #2 as its own reviewable commit

A perfectly clean #2-only _diff_ isn't possible — the catalog files were untracked WIP with no committed baseline, so the #2 commit contains those files in full (their scaffold structure + my changes), not just my lines. It's still a reasonable reviewable boundary. Do two commits:

1. Scaffold baseline — everything EXCEPT the #2 files below:
   ```
   git add CONTEXT.md docs office365-handoff.md plan src/graph.ts src/types.ts tsconfig.json
   git commit -m "chore: scaffold m365vault app + domain docs"
   ```
2. The #2 work — stage exactly this set:
   ```
   git add src/schema.ts src/catalog.ts src/coordinator.ts src/consumer.ts \
           src/restore.ts src/retention.ts src/workflow.ts src/index.ts \
           migrations/0001_init.sql wrangler.jsonc worker-configuration.d.ts \
           vitest.config.mts test/ package.json pnpm-lock.yaml
   git commit -m "feat: per-tenant catalog in TenantCoordinator DO SQLite (#2)"
   ```
   (`src/graph.ts` and `src/types.ts` are scaffold the #2 code imports but did not change — they belong in commit 1, which must land first.)

- Either way: the pre-commit hook reformats double-quoted scaffold files (e.g. `src/graph.ts`, `src/types.ts`) to the repo standard (single quotes, tabs, width 140) and will **block** if oxlint flags any staged file — be ready for that on the older scaffold files. After the hook runs, re-run `pnpm test` and `npx tsc --noEmit` to confirm still green.

## What #2 changed

- **Decision (confirmed with user):** the per-tenant catalog lives in each **`TenantCoordinator` Durable Object's SQLite** (routed free via `idFromName`); the `tenants` **registry** stays in a **control-plane D1** (the existing `DB` binding). Rationale: dynamic per-tenant D1 routing at runtime is still roadmap-only (workerd #3564). Matches ADR 0003.
- **Schema split:**
  - `migrations/0001_init.sql` → control-plane only (`tenants` table).
  - `src/schema.ts` (new) → `CATALOG_SCHEMA`: per-tenant DDL (resources/runs/blobs/items/item_versions + indexes + `current_items` view). `tenant_id` columns dropped (the DO _is_ the tenant); `CREATE … IF NOT EXISTS`.
- **`src/catalog.ts`** rewritten from D1 async `prepare/batch` → synchronous DO `ctx.storage.sql.exec` + `transactionSync`. Takes `DurableObjectStorage`. Added `pointInTime`, `expireVersions`, `removeBlobs`. `openRun` now takes `retentionDays`.
- **`src/coordinator.ts`** — constructor applies `CATALOG_SCHEMA` via `blockConcurrencyWhile`; thin catalog RPC methods delegate to `catalog.ts`.
- **Orchestrators** route through `tenantStub(env, tenantId)`: `consumer.ts` (blobExists/indexItem), `workflow.ts` (reads `retention_days` from control-plane D1, calls `openRun`/`finalizeRun`), `restore.ts` (`pointInTime`), `retention.ts` (per-tenant DO GC paging). `index.ts` cron enumeration unchanged.
- **`wrangler.jsonc`** — `database_name` → `m365vault-control-plane`. Types regenerated (`wrangler types`).
- **Tests (new — repo's first):** `vitest.config.mts`, `test/catalog.test.ts`, `test/env.d.ts`. `@cloudflare/vitest-pool-workers` 0.16 + `vitest` 4. **3/3 pass.** `package.json` has `"test": "vitest run"`.

## Gotchas the next agent must know

1. **DO SQLite ENFORCES foreign keys by default; D1 does not.** The original D1 schema treated FKs as decorative (the partial-unique index is the real guard). In the DO they're live, so the `items.resource_key → resources` FK broke every insert (`resources` is never populated yet — that's scope-discovery work, #3/#4). Fix: all `REFERENCES` clauses dropped from `src/schema.ts` (documented in its header comment).
2. **vitest-pool-workers 0.16 (vitest 4 line) changed the config API:** no more `defineWorkersConfig` from `/config`. Use the `cloudflareTest(...)` **plugin** in `defineConfig({ plugins: [...] })`, and the config file must be **`.mts`** (the plugin is ESM-only; Vite was loading the config via `require`).
3. **Fixed a pre-existing bug while porting `finalizeRun`:** old code bound `runId` to `finished_at` (UUID into a timestamp column); now binds `Date.now()`.

## Verify (all currently green)

```
pnpm test
npx tsc --noEmit
npx oxlint src test
npx oxfmt --check src test
```

## What to start next

Per `docs/SETUP.md` build order: #2 done → **inner vertical slice = #3 + #5 + #7 + #8**.

- **#3** Mail delta must be per-folder — enumerate the mailbox folder tree in scope discovery; model a mail folder as its own Resource (see TODO in `src/graph.ts` `deltaRoot`). Natural first step now that the catalog exists.
- **#4** OneDrive is never backed up — emit a `drive` Resource per user in scope discovery (`listUsers` currently emits only `mailbox`).
- **#5** Rate-limit backoff shares the queue retry budget — first seed dead-letters.
- **#7** Stream mail unconditionally (mail `size` is always 0 from the delta page, so it never takes the multipart path).
- **#8** Graph client throttle/identity hygiene (User-Agent, ImmutableId, single client_id, RateLimit-Reset, 12/s).
- **#9** is now _mostly dissolved by #2_: DO SQLite has no 1,000-query/invocation cap and GC is already per-tenant. Only its batch-size note remains, already satisfied by the paging in `retention.ts`. Likely closeable — confirm with the user.

Planning doc for #2: `~/.claude/plans/pure-seeking-rocket.md`.
