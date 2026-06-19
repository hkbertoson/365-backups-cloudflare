# m365vault — Session Handoff

**Purpose:** Enable a fresh agent to continue work on m365vault, a Microsoft 365 backup engine built on Cloudflare. Generated 2026-06-18.

## Project in one paragraph

m365vault backs up Microsoft 365 tenants (mail, OneDrive/SharePoint, Teams, calendar/contacts) by pulling from Microsoft Graph on a schedule, storing the bytes in R2, cataloging them in D1, and supporting granular point-in-time restore. It runs entirely on Cloudflare: Workers + Workflows (orchestration), Durable Objects (per-tenant coordinator + Graph rate governor), Queues (fan-out), R2 (blob store — the foundation), D1 (catalog/index), KV (config), Secrets Store (credentials), Cron (scheduling).

## Status

Design / exploration phase. No code was committed this session. Four reference artifacts were produced (listed below). The architecture, data model, risks, and recommended build order are fully written up in the design summary — read it first.

## Reference artifacts — read these, don't re-derive

These were delivered as downloadable files in the originating chat (filenames below). Make sure they're saved into the target repo before continuing; if they aren't on disk, ask the user for the chat downloads. Their content is intentionally **not** repeated in this handoff.

- @plans/m365vault-design.md — **start here.** Full design summary: primitive→role mapping, backup-run flow, data-model rationale, restore, the hard parts, and suggested build order.
- @plans/m365vault-schema.sql — D1 catalog schema. Temporal versioning (`item_versions` validity intervals), content-addressed dedupe (`blobs`), the enforced single-current-version invariant, and the canonical point-in-time restore query.
- @plans/m365vault-skeleton.ts — pseudocode skeleton: cron entry, `BackupWorkflow`, `TenantCoordinator` Durable Object (lease + delta cursors + token-bucket rate limiter), queue consumer, Graph client sketch, restore sketch.
- @plans/m365-backup-architecture.svg — architecture overview diagram.

## What the next session should do

No specific focus was provided this session, so default to the open items from the design summary's "Open next steps":

1. Implement the real `indexItem` transaction in TypeScript — atomic close-old-version / open-new-version (see the write-path comment block in `@plans/m365vault-schema.sql).
2. Build the retention/GC job: expire closed versions past retention, decrement `blobs.ref_count`, delete zero-ref objects from R2.
3. Author `wrangler.jsonc` wiring all bindings (Workflow, Queue, DO namespace, R2, D1, KV, Secrets Store).

Recommended approach (per the design summary): build the inner vertical slice first — one Durable Object plus one consumer pulling a single mailbox's delta pages into R2 + D1, with the token bucket and 429 handling working end to end — before adding the Workflow and fan-out. All the real risk lives in that slice.

## Risks / gotchas

Do not re-derive these — see @plans/m365vault-design.md → "The hard parts." Headline items: Microsoft Graph throttling is the dominant constraint (per app/tenant/service, 429 + Retry-After); large files must be chunked/ranged because of Worker time limits; delta cursors expire and need a full-resync fallback; restore fidelity (permissions, version history) is the hard half of the product.

## Suggested skills

Invoke these as the work calls for them. Per this environment's rules, always read the skill's `SKILL.md` before creating the corresponding file type.

- **frontend-design** — when building the m365vault admin / restore dashboard UI (e.g. React on Workers). Not needed for the backend slice above.
- **docx** or **pdf** — if producing a stakeholder or compliance deliverable, such as a restore runbook or a data-handling / SOC2-style document.
- **file-reading** / **pdf-reading** — if the user uploads Microsoft Graph specs, throttling references, or compliance PDFs to build from.
- No dedicated skill exists for the core TypeScript / SQL / Wrangler work; proceed normally for those.

## Environment

- Stack: TypeScript on Cloudflare Workers/Workflows/Queues/Durable Objects/R2/D1/KV (Hono likely). Integrates with Microsoft Graph via app-registration / client-credentials auth.
