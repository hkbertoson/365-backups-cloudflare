---
title: Domain glossary
description: The ubiquitous language of m365vault — every domain term, its precise meaning, the resource_key format, and the synonyms to avoid.
---

This page fixes the ubiquitous language of m365vault. The same words appear in
the code (table names, column names, binding names) and in this documentation,
and they mean exactly one thing. Each entry lists the synonyms to **avoid** so
that fuzzy words like "snapshot" or "mailbox" never stand in for a precise term.

For how these terms compose into point-in-time history, see the
[temporal model](/concepts/temporal-model/); for how they map onto storage, see
[storage and the catalog](/architecture/storage-and-catalog/).

## Tenant

A customer's Microsoft 365 organization — one Azure AD tenant GUID — that
m365vault backs up. Each Tenant is one row in the control-plane `tenants`
registry (in D1) and one `TenantCoordinator` Durable Object that owns the
tenant's catalog and Delta Cursors. The DO boundary **is** the Tenant: the
per-tenant catalog tables carry no `tenant_id` column because there is one
catalog per Tenant.

_Avoid_: customer, org, account, company.

## Scope Container

A Graph object that is not itself delta-trackable but **expands into Resources**
during discovery. The two kinds are a **mailbox** (which expands into its mail
folders) and a **SharePoint site** (which expands into its document-library
drive). A Scope Container is never a unit of backup work on its own; only the
Resources it expands into are.

_Avoid_: parent, root, target.

## Resource

The unit of backup work, and the owner of exactly one [Delta Cursor](#delta-cursor):
a single delta-trackable collection — a **mail folder** or a **drive**. A mailbox
or site is a Scope Container that expands into Resources; it is not itself a
Resource.

A Resource is identified by a **`resource_key`**. The glossary form is
`"<kind>:<graph_id>"` — but because mail-folder ids are mailbox-scoped (not
unique tenant-wide), a mailfolder Resource is namespaced by its owning user:

```ts
// from src/types.ts
resourceKey = (r) =>
	r.kind === 'mailfolder'
		? `mailfolder:${r.ownerId}:${r.id}` // owner-namespaced
		: `${r.kind}:${r.id}`; // drive:<id>, site:<id>
```

The `resource_key` is reused as the Delta Cursor storage key, the catalog
`resource_key` column (in `resources`, `items`, and the point-in-time query),
and a fragment of the Blob R2 key — so it must be unique tenant-wide. In code a
Resource is a discriminated union where only the `mailfolder` variant carries
`ownerId`, making the namespacing a compile-time guarantee.

_Avoid_: mailbox (as a synonym for Resource), source, backup target.

## Run

One backup execution for a Tenant. A Run **is** a [Restore Point](#restore-point):
its `started_at` is the time anchor that every point-in-time query resolves
against. A Run is one row in the `runs` table with a `kind` of `full` or
`incremental` and a `status` of `running`, `completed`, `partial`, or `failed`.
The `started_at` value is forced strictly past the previous Run's `started_at`,
so two Runs in the same millisecond can never produce a zero-length validity
interval that point-in-time reads would skip.

_Avoid_: job, backup, snapshot.

## Restore Point

The recoverable state of a Tenant as it existed at the instant of a Run's
`started_at`. It is a synonym for a completed Run, used when talking about
restore rather than capture. There is no separate "restore point" object: you
restore _to a Run_ by reconstructing every Item Version that was current at that
Run's `started_at`.

_Avoid_: snapshot, checkpoint, version.

## Item

The logical identity of one backed-up object — an email, a file, a calendar
event, a contact — stable across content changes. One row in `items` per
real-world object, keyed by `(resource_key, graph_item_id)` and assigned an
internal `item_uid`. An Item's content history lives in its
[Item Versions](#item-version); the Item row itself never changes when content
changes.

_Avoid_: object, record, document.

## Item Version

One temporal content state of an Item, valid over the half-open interval
`[valid_from_ts, valid_to_ts)`. One row in `item_versions` per observed content
change. The **open** version (`valid_to_ts IS NULL`) is the current one, and a
partial unique index enforces **at most one open version per Item**. A new
content state closes the previously-open version (sets its `valid_to_ts`) and
opens a fresh one in the same synchronous transaction.

_Avoid_: revision, snapshot, generation.

## Blob

A stored R2 object keyed by a **content address**: a true sha-256 of the bytes
for small drive files, or a Graph `etag:` surrogate for mail and large files
(which are streamed, never fully buffered, so they are unhashable). One address
maps to exactly one R2 object; the `blobs.ref_count` column tracks how many Item
Versions point at it, enabling safe garbage collection. The etag surrogate makes
mail and large-file dedupe etag-keyed (an unchanged item produces the same etag,
so it is skipped) rather than byte-exact. A tombstone holds no Blob reference.

_Avoid_: file, object, attachment, payload.

## Delta Cursor

The Graph `deltaLink` token marking how far incremental sync has progressed for
one delta collection (one Resource). It is held authoritatively and strongly
consistently in the Tenant's `TenantCoordinator` Durable Object storage (under
`cursor:` keys), not in the catalog SQLite — the `resources` table only mirrors
sync metadata for reporting. Setting a Delta Cursor to `null` forces a full
resync of that Resource.

_Avoid_: bookmark, checkpoint, offset, watermark.

## Seed

The initial full backup of a Tenant, before any Delta Cursor exists — the
multi-hour first Run (`kind = 'full'`). It is distinguished from the nightly
`incremental` Runs that follow, which resume from each Resource's stored Delta
Cursor.

_Avoid_: full sync, first run, bootstrap.

## Tombstone

An Item Version recording that the source deleted the Item (`is_deleted = 1`).
It closes the previously-current Version and is itself **blobless**
(`content_hash IS NULL`) — the schema's `CHECK (is_deleted = 1 OR content_hash
IS NOT NULL)` permits a null content hash only for tombstones. Because the
tombstone holds no Blob reference, once the now-closed content Version expires
under retention, its Blob's `ref_count` drops to zero and the Blob becomes
reclaimable. The bytes are retained until retention GC expires them.

_Avoid_: deletion record, gravestone.

:::note
The control-plane `tenants` registry lives in a **separate D1 database**; the
catalog (`runs`, `blobs`, `items`, `item_versions`, `resources`) lives **inside
each Tenant's Durable Object SQLite**. The two never share a table, which is why
the catalog tables carry no `tenant_id`. See
[storage and the catalog](/architecture/storage-and-catalog/).
:::
