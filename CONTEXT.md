# m365vault

A Microsoft 365 backup engine on Cloudflare: it pulls tenant data from Microsoft Graph on a schedule, stores the bytes in R2, catalogs them in D1, and restores any item to any past point in time. This glossary fixes the ubiquitous language; it is not a spec.

## Language

**Tenant**:
A customer's Microsoft 365 organization (one Azure AD tenant GUID) that m365vault backs up. One row in `tenants`, one `TenantCoordinator` Durable Object.
_Avoid_: customer, org, account, company.

**Scope Container**:
A Graph object that is not itself delta-trackable but expands into Resources during discovery: a mailbox (→ its mail folders) or a SharePoint site (→ its document-library drive).
_Avoid_: parent, root, target.

**Resource**:
The unit of backup work and of exactly one Delta Cursor: a single delta-trackable collection — a **mail folder** or a **drive**. Identified by `resource_key = "<kind>:<graph_id>"`. A mailbox or site is a Scope Container that expands into Resources; it is not itself a Resource.
_Avoid_: mailbox (as synonym), source, backup target.

**Run**:
One backup execution for a Tenant. A Run **is** a Restore Point — its `started_at` is the time anchor every point-in-time query resolves against.
_Avoid_: job, backup, snapshot.

**Restore Point**:
The recoverable state of a Tenant as it existed at the instant of a Run's `started_at`. Synonym for a completed Run, used when talking about restore rather than capture.
_Avoid_: snapshot, checkpoint, version.

**Item**:
The logical identity of one backed-up object — an email, a file, a calendar event, a contact — stable across content changes. Its content history lives in Item Versions.
_Avoid_: object, record, document.

**Item Version**:
One temporal content state of an Item, valid over the half-open interval `[valid_from_ts, valid_to_ts)`. The open version (`valid_to_ts IS NULL`) is the current one; at most one is open per Item.
_Avoid_: revision, snapshot, generation.

**Blob**:
A stored R2 object keyed by a **content address**: a true sha-256 of the bytes for small drive files, or a Graph `etag:` surrogate for mail and large files (streamed, never fully buffered, so unhashable). One address → one R2 object; `ref_count` tracks how many Item Versions point at it. The surrogate makes mail/large-file dedupe etag-keyed (unchanged item → same etag → skip) rather than byte-exact.
_Avoid_: file, object, attachment, payload.

**Delta Cursor**:
The Graph `deltaLink` token marking how far incremental sync has progressed for one delta collection. Held authoritatively (strongly consistent) in the Tenant's Durable Object; setting it to null forces a full resync.
_Avoid_: bookmark, checkpoint, offset, watermark.

**Seed**:
The initial full backup of a Tenant, before any Delta Cursor exists — the multi-hour first Run. Distinguished from the nightly incremental Runs that follow.
_Avoid_: full sync, first run, bootstrap.

**Tombstone**:
An Item Version recording that the source deleted the Item (`is_deleted = 1`); it closes the previously-current Version. The bytes are retained until retention GC expires them.
_Avoid_: deletion record, gravestone.
