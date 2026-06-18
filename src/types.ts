import type { TenantCoordinator } from './coordinator';

// ============================================================
// Shared domain types + module contracts.
// This file is the stable boundary the parallel modules build against.
// Implementations live in coordinator.ts / catalog.ts / retention.ts /
// graph.ts / consumer.ts / workflow.ts / restore.ts.
// ============================================================

export type ResourceKind = 'mailbox' | 'drive' | 'site';
export type Resource = { kind: ResourceKind; id: string };

export type ItemType = 'message' | 'file' | 'event' | 'contact';

// One observed item from a Graph delta page. `version` is Graph's cheap
// content tag (etag/cTag); `contentHash` (sha-256 of the bytes) is computed
// by the consumer after download and drives content-addressed dedupe.
export type BackupItem = {
	id: string; // stable Graph id
	version: string; // graph etag/cTag — cheap change signal
	size: number;
	itemType: ItemType;
	name?: string;
	parentPath?: string;
	metadata?: Record<string, unknown>;
	isDeleted?: boolean; // delta tombstone: removed at source
};

export type DeltaPage = {
	items: BackupItem[];
	nextLink?: string; // more pages for this resource
	deltaLink?: string; // end of pages: the cursor to persist
};

// One queue message == one PAGE of one resource. cursor:null => use the
// stored delta link (or full resync if none).
export type BackupJob = {
	tenantId: string;
	runId: string;
	resource: Resource;
	cursor: string | null;
};

export const MULTIPART_THRESHOLD = 8 * 1024 * 1024; // stream anything bigger
export const LEASE_TTL_MS = 6 * 60 * 60 * 1000; // 6h safety net on a stuck run

export const resourceKey = (r: Resource): string => `${r.kind}:${r.id}`;

// Typed RPC stub for the per-tenant Durable Object. Centralized so callers
// get TenantCoordinator's method types (the generated binding is not generic).
export const tenantStub = (env: Env, tenantId: string): DurableObjectStub<TenantCoordinator> =>
	env.TENANT.get(env.TENANT.idFromName(tenantId)) as unknown as DurableObjectStub<TenantCoordinator>;
