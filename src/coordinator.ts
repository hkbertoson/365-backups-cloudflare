import { DurableObject } from 'cloudflare:workers';
import {
	blobExists,
	type DeadBlob,
	expireVersions,
	finalizeRun,
	indexItem,
	type IndexItemInput,
	openRun,
	pointInTime,
	removeBlobs,
	type RestoreRow,
} from './catalog';
import { CATALOG_SCHEMA } from './schema';
import { LEASE_TTL_MS } from './types';

// ============================================================
// TenantCoordinator — per-tenant coordinator + Graph rate governor + catalog.
// Serializes runs (lease), owns delta cursors (strongly consistent), runs the
// token-bucket rate limiter, tracks run completion, and holds the tenant's
// catalog in its own SQLite (ADR 0003) — routed for free via idFromName.
//
// All state lives in ctx.storage: strongly consistent and durable across
// DO restarts (Date.now() reads the normal wall clock inside the DO).
// ============================================================
export class TenantCoordinator extends DurableObject<Env> {
	// Token-bucket sizing. Tune to Graph's per-tenant/per-service throttling
	// limits: CAP is the allowed burst, REFILL_PER_SEC the steady-state rate.
	static CAP = 30;
	static REFILL_PER_SEC = 8;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		// Apply the per-tenant catalog schema once, before any request. The DDL
		// is all CREATE ... IF NOT EXISTS, so this is a no-op after first start.
		ctx.blockConcurrencyWhile(async () => {
			ctx.storage.sql.exec(CATALOG_SCHEMA);
		});
	}

	// --- catalog: the tenant's own SQLite (delegates to catalog.ts) ---
	openRun(kind: 'full' | 'incremental', totalResources: number, retentionDays: number): string {
		return openRun(this.ctx.storage, kind, totalResources, retentionDays);
	}
	finalizeRun(runId: string): void {
		finalizeRun(this.ctx.storage, runId);
	}
	blobExists(contentHash: string): string | null {
		return blobExists(this.ctx.storage, contentHash);
	}
	indexItem(input: IndexItemInput): void {
		indexItem(this.ctx.storage, input);
	}
	pointInTime(runId: string, resourceKey: string): RestoreRow[] {
		return pointInTime(this.ctx.storage, runId, resourceKey);
	}
	expireVersions(cutoff: number, limit: number): { expired: number; dead: DeadBlob[] } {
		return expireVersions(this.ctx.storage, cutoff, limit);
	}
	removeBlobs(hashes: string[]): void {
		removeBlobs(this.ctx.storage, hashes);
	}

	// --- lease: only one backup run at a time per tenant ---
	async acquireLease(): Promise<{ acquired: boolean }> {
		const held = await this.ctx.storage.get<number>('lease');
		if (held && Date.now() - held < LEASE_TTL_MS) return { acquired: false };
		await this.ctx.storage.put('lease', Date.now());
		return { acquired: true };
	}
	async releaseLease(): Promise<void> {
		await this.ctx.storage.delete('lease');
	}

	// --- delta cursors: the incremental-backup memory; survive restarts.
	// setCursor(key, null) forces a full resync on the next page. ---
	async getCursor(key: string): Promise<string | null> {
		return (await this.ctx.storage.get<string>(`cursor:${key}`)) ?? null;
	}
	async setCursor(key: string, deltaLink: string | null): Promise<void> {
		if (deltaLink === null) await this.ctx.storage.delete(`cursor:${key}`);
		else await this.ctx.storage.put(`cursor:${key}`, deltaLink);
	}

	// --- rate governor: token bucket. Returns ms to wait (0 = go now). ---
	async takeToken(): Promise<number> {
		const now = Date.now();
		const bucket = (await this.ctx.storage.get<{
			tokens: number;
			ts: number;
		}>('bucket')) ?? { tokens: TenantCoordinator.CAP, ts: now };
		const tokens = Math.min(TenantCoordinator.CAP, bucket.tokens + ((now - bucket.ts) / 1000) * TenantCoordinator.REFILL_PER_SEC);
		if (tokens >= 1) {
			await this.ctx.storage.put('bucket', { tokens: tokens - 1, ts: now });
			return 0;
		}
		await this.ctx.storage.put('bucket', { tokens, ts: now });
		return Math.ceil(((1 - tokens) / TenantCoordinator.REFILL_PER_SEC) * 1000);
	}

	// --- completion tracking (resource-level, not page-level) ---
	async setOutstanding(n: number): Promise<void> {
		await this.ctx.storage.put('outstanding', n);
	}
	async outstanding(): Promise<number> {
		return (await this.ctx.storage.get<number>('outstanding')) ?? 0;
	}
	async decrOutstanding(): Promise<number> {
		const n = Math.max(0, ((await this.ctx.storage.get<number>('outstanding')) ?? 0) - 1);
		await this.ctx.storage.put('outstanding', n);
		return n;
	}
}
