---
title: Architecture decision records
description: An index of the architecture decision records that fix the foundational design choices behind the m365vault backup engine.
---

Architecture Decision Records (ADRs) capture the significant design choices behind m365vault — what we decided, the context that forced the decision, the options we rejected, and the consequences we accepted. Each ADR is immutable once recorded: when a later decision changes course, we write a new ADR rather than rewriting an old one, so the reasoning trail stays intact.

These four records define the load-bearing decisions of the backup engine. Read them alongside the [domain glossary](/concepts/domain-glossary/), which fixes the ubiquitous language (Tenant, Scope Container, Resource, Run, Restore Point, Item, Item Version, Blob, Delta Cursor, Seed, Tombstone) that the ADRs use throughout.

## The records

- [Single multi-tenant Graph app + conservative reactive throttling](/adr/multi-tenant-and-throttle-governance/) — one admin-consented Azure AD app for all customers, with a conservative per-tenant token bucket and reactive backoff in place of adaptive limiting.
- [Resource = delta collection](/adr/resource-equals-delta-collection/) — the unit of backup work is a single delta-trackable collection (a mail folder or a drive), not a whole mailbox or site.
- [Per-tenant D1 catalog](/adr/per-tenant-catalog/) — one D1 database per Tenant, with per-tenant content-addressed dedupe and a ~300-mailbox v1 ceiling.
- [MVP scope](/adr/mvp-scope/) — mail and OneDrive capture plus baseline restore in scope; SharePoint, Teams, restore fidelity, and adaptive throttling deferred.

:::note
The ADRs cross-reference each other: the MVP scope record (0004) defers work to the throttling record (0001) and the catalog record (0003), and the catalog record amends the scale envelope that the others assume. Follow the links to keep the dependencies straight.
:::
