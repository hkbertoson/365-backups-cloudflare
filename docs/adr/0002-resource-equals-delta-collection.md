# Resource = delta collection (mail folder or drive), not mailbox/site

A **Resource** — the unit of one queue job, one Delta Cursor, and one completion-counter tick — is a single Graph delta-trackable **collection**: a **mail folder** or a **drive**. Mailboxes and SharePoint sites are **Scope Containers** expanded into Resources during `discover-scope` (a mailbox → its folder tree; each user → their OneDrive drive; a site → its default document-library drive). Chosen because Graph exposes delta only per mail folder and per drive, so any coarser unit forces a stateful, long-running nested folder loop into a single queue message.

## Considered Options

- **Coarse Resource = mailbox / drive / site** (the original sketch) — rejected. It pushes per-folder cursor juggling and an unbounded folder loop into one consumer invocation (Worker-limit risk) and breaks the one-tick-per-resource completion counter.

## Consequences

- **Large fan-out, by design.** A 2,000-mailbox tenant expands to tens of thousands of Resources per Run (folders × mailboxes, plus one drive per user, plus sites). Traded deliberately for a uniform, stateless consumer: every queue job is "sync one collection from one cursor," and the existing per-page self-re-enqueue handles continuation.
- **Discovery costs more Graph calls** — `discover-scope` must enumerate each mailbox's folder tree (recursively).
- **The completion counter counts Resources (collections), not mailboxes.**
- **OneDrive is now in scope.** The previous discovery emitted only `mailbox` + `site`; each user's OneDrive `drive` was silently never backed up.
