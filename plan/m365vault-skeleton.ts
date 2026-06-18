// ============================================================
// m365vault — backup engine skeleton (PSEUDOCODE)
// Cloudflare Workers + Workflows + Queues + Durable Objects + R2 + D1
// Concrete where it matters; `TODO`/sketch where it's just plumbing.
// ============================================================

import { WorkflowEntrypoint, type WorkflowStep, type WorkflowEvent } from 'cloudflare:workers';
import { DurableObject } from 'cloudflare:workers';

// ---- Bindings (wrangler.jsonc) ----
interface Env {
	BACKUP_WORKFLOW: Workflow; // Workflows binding
	BACKUP_QUEUE: Queue<BackupJob>; // producer + consumer
	TENANT: DurableObjectNamespace<TenantCoordinator>;
	BLOBS: R2Bucket; // R2 — the bytes
	DB: D1Database; // D1 — the catalog/index
	CONFIG: KVNamespace; // KV — per-tenant config / hot lookups
	// app-registration secret + per-tenant refresh tokens come from Secrets Store
}

type Resource = { kind: 'mailbox' | 'drive' | 'site'; id: string };
type BackupJob = { tenantId: string; runId: string; resource: Resource; cursor: string | null };

const MULTIPART_THRESHOLD = 8 * 1024 * 1024; // stream anything bigger
const LEASE_TTL = 6 * 60 * 60 * 1000; // 6h safety net on a stuck run

// typed RPC stub for the per-tenant DO
const tenantStub = (env: Env, tenantId: string) => env.TENANT.get(env.TENANT.idFromName(tenantId));

// ============================================================
// 1. CRON — kick off one Workflow per tenant. Also hosts the queue consumer.
// ============================================================
export default {
	async scheduled(_event: ScheduledEvent, env: Env) {
		const { results } = await env.DB.prepare('SELECT tenant_id FROM tenants WHERE backup_enabled = 1').all<{ tenant_id: string }>();

		for (const { tenant_id } of results) {
			await env.BACKUP_WORKFLOW.create({ params: { tenantId: tenant_id } });
		}
	},

	async queue(batch: MessageBatch<BackupJob>, env: Env) {
		return handleBackupBatch(batch, env);
	},
};

// ============================================================
// 2. WORKFLOW — the per-run "brain". Durable + resumable: each step.do()
//    checkpoints, so a crash resumes from the last completed step.
// ============================================================
export class BackupWorkflow extends WorkflowEntrypoint<Env, { tenantId: string }> {
	async run(event: WorkflowEvent<{ tenantId: string }>, step: WorkflowStep) {
		const { tenantId } = event.payload;
		const coordinator = tenantStub(this.env, tenantId);

		// 2a. One run per tenant. If a run is already in flight, bail cleanly.
		const lease = await step.do('acquire-lease', () => coordinator.acquireLease());
		if (!lease.acquired) return;

		try {
			// 2b. Discover scope — which mailboxes / drives / sites exist
			const scope = await step.do('discover-scope', async () => {
				const users = await graph.listUsers(tenantId); // mailboxes + OneDrive
				const sites = await graph.listSites(tenantId); // SharePoint
				return buildResourceList(users, sites); // Resource[]
			});

			// 2c. Open a run row and prime the completion counter (= # of resources)
			const runId = await step.do('open-run', () => openRun(this.env.DB, tenantId, scope.length));
			await step.do('prime-counter', () => coordinator.setOutstanding(scope.length));

			// 2d. Fan out — one queue job per resource. cursor:null => use stored delta link.
			await step.do('fan-out', async () => {
				for (const resource of scope) {
					await this.env.BACKUP_QUEUE.send({ tenantId, runId, resource, cursor: null });
				}
			});

			// 2e. Wait for consumers to drain. Workflows sleep cheaply for long stretches,
			//     so polling the DO counter every 30s is fine even for multi-hour seeds.
			while ((await coordinator.outstanding()) > 0) {
				await step.sleep('await-drain', '30 seconds');
			}

			// 2f. Seal the restore point.
			await step.do('finalize', () => finalizeRun(this.env.DB, runId));
		} finally {
			await step.do('release-lease', () => coordinator.releaseLease());
		}
	}
}

// ============================================================
// 3. DURABLE OBJECT — per-tenant coordinator + rate governor.
//    Serializes runs, owns delta cursors (strongly consistent), throttles Graph.
// ============================================================
export class TenantCoordinator extends DurableObject<Env> {
	static CAP = 30; // burst size  } tune to Graph's
	static REFILL_PER_SEC = 8; // steady rate } per-tenant limits

	// --- lease: only one backup run at a time ---
	async acquireLease(): Promise<{ acquired: boolean }> {
		const held = await this.ctx.storage.get<number>('lease');
		if (held && Date.now() - held < LEASE_TTL) return { acquired: false };
		await this.ctx.storage.put('lease', Date.now());
		return { acquired: true };
	}
	async releaseLease() {
		await this.ctx.storage.delete('lease');
	}

	// --- delta cursors: the incremental-backup memory, must survive restarts ---
	async getCursor(key: string) {
		return (await this.ctx.storage.get<string>(`cursor:${key}`)) ?? null;
	}
	async setCursor(key: string, deltaLink: string | null) {
		if (deltaLink === null)
			await this.ctx.storage.delete(`cursor:${key}`); // force full resync
		else await this.ctx.storage.put(`cursor:${key}`, deltaLink);
	}

	// --- rate governor: token bucket. Returns ms to wait (0 = go now). ---
	async takeToken(): Promise<number> {
		const now = Date.now();
		const b = (await this.ctx.storage.get<{ tokens: number; ts: number }>('bucket')) ?? { tokens: TenantCoordinator.CAP, ts: now };
		let tokens = Math.min(TenantCoordinator.CAP, b.tokens + ((now - b.ts) / 1000) * TenantCoordinator.REFILL_PER_SEC);
		if (tokens >= 1) {
			await this.ctx.storage.put('bucket', { tokens: tokens - 1, ts: now });
			return 0;
		}
		await this.ctx.storage.put('bucket', { tokens, ts: now });
		return Math.ceil(((1 - tokens) / TenantCoordinator.REFILL_PER_SEC) * 1000);
	}

	// --- completion tracking (resource-level, not page-level) ---
	async setOutstanding(n: number) {
		await this.ctx.storage.put('outstanding', n);
	}
	async outstanding() {
		return (await this.ctx.storage.get<number>('outstanding')) ?? 0;
	}
	async decrOutstanding() {
		const n = Math.max(0, ((await this.ctx.storage.get<number>('outstanding')) ?? 0) - 1);
		await this.ctx.storage.put('outstanding', n);
		return n;
	}
}

// ============================================================
// 4. QUEUE CONSUMER — does the real work: Graph -> R2 (bytes) + D1 (index).
//    One message == one PAGE of one resource. Pages re-enqueue themselves.
// ============================================================
async function handleBackupBatch(batch: MessageBatch<BackupJob>, env: Env) {
	for (const msg of batch.messages) {
		const job = msg.body;
		const coordinator = tenantStub(env, job.tenantId);
		const key = `${job.resource.kind}:${job.resource.id}`;

		// 4a. Spend a rate token before touching Graph. No token -> back off & retry.
		const waitMs = await coordinator.takeToken();
		if (waitMs > 0) {
			msg.retry({ delaySeconds: Math.ceil(waitMs / 1000) });
			continue;
		}

		try {
			// 4b. Resume from this page's cursor, else stored delta link, else full sync (null).
			const cursor = job.cursor ?? (await coordinator.getCursor(key));
			const page = await graph.deltaPage(job.resource, cursor); // {items, nextLink, deltaLink}

			// 4c. Persist each changed item: bytes -> R2, metadata row -> D1.
			for (const item of page.items) {
				const r2Key = `${job.tenantId}/${key}/${item.id}/${item.version}`;
				if (item.size > MULTIPART_THRESHOLD) {
					await streamMultipart(env.BLOBS, r2Key, () => graph.downloadStream(item)); // ranged
				} else {
					await env.BLOBS.put(r2Key, await graph.download(item));
				}
				await indexItem(env.DB, job.runId, key, item, r2Key); // upsert into D1 catalog
			}

			if (page.nextLink) {
				// 4d. More pages for THIS resource — re-enqueue, do NOT mark done yet.
				await env.BACKUP_QUEUE.send({ ...job, cursor: page.nextLink });
			} else {
				// 4e. Resource fully synced — save new delta cursor + tick the counter down.
				await coordinator.setCursor(key, page.deltaLink);
				await coordinator.decrOutstanding();
			}
			msg.ack();
		} catch (e) {
			if (isThrottled(e)) {
				// Graph 429 — obey Retry-After
				msg.retry({ delaySeconds: retryAfter(e) });
			} else if (isCursorInvalid(e)) {
				// delta token expired/invalid
				await coordinator.setCursor(key, null); // next attempt does a full resync
				msg.retry({ delaySeconds: 5 });
			} else {
				msg.retry(); // after max retries -> dead-letter queue
			}
		}
	}
}

// ============================================================
// 5. GRAPH CLIENT (sketch) — auth + delta + download
// ============================================================
const graph = {
	async token(tenantId: string) {
		// TODO: client-credentials flow; app secret from Secrets Store.
		// Cache token in KV (or the DO) until ~expiry.
	},
	async deltaPage(resource: Resource, cursor: string | null) {
		// TODO: if cursor -> follow it (nextLink/deltaLink). else hit the delta root, e.g.
		//   mailbox: /users/{id}/mailFolders/.../messages/delta
		//   drive:   /drives/{id}/root/delta
		// return { items: BackupItem[], nextLink?: string, deltaLink?: string }
		return { items: [] as BackupItem[], nextLink: undefined, deltaLink: '' };
	},
	async download(item: BackupItem): Promise<ArrayBuffer> {
		return new ArrayBuffer(0);
	}, // small
	async downloadStream(item: BackupItem): Promise<ReadableStream> {
		return new ReadableStream();
	}, // ranged
	async listUsers(tenantId: string) {
		return [];
	},
	async listSites(tenantId: string) {
		return [];
	},
	async writeBack(tenantId: string, key: string, blob: unknown) {
		/* needs *.ReadWrite scopes */
	},
};

// ============================================================
// 6. RESTORE (sketch) — the reverse path (green dashed line in the diagram).
//    Backup is the easy half; restore fidelity is where the real work lives.
// ============================================================
async function restore(env: Env, p: { tenantId: string; restorePointId: string }) {
	const { results } = await env.DB.prepare('SELECT resource_key, item_id, r2_key FROM index_items WHERE run_id = ?')
		.bind(p.restorePointId)
		.all<{ resource_key: string; item_id: string; r2_key: string }>();

	for (const it of results) {
		const blob = await env.BLOBS.get(it.r2_key);
		await graph.writeBack(p.tenantId, it.resource_key, blob);
		// HARD PART: permissions, version history, dedupe, conflict handling, in-place vs. new.
	}
}

// ---- helpers referenced above (sketches) ----
type BackupItem = { id: string; version: string; size: number };
function buildResourceList(users: unknown[], sites: unknown[]): Resource[] {
	return [];
}
async function openRun(db: D1Database, tenantId: string, total: number): Promise<string> {
	return 'run_id';
}
async function finalizeRun(db: D1Database, runId: string) {}
async function indexItem(db: D1Database, runId: string, key: string, item: BackupItem, r2Key: string) {}
async function streamMultipart(bucket: R2Bucket, key: string, src: () => Promise<ReadableStream>) {}
function isThrottled(e: unknown): boolean {
	return false;
}
function isCursorInvalid(e: unknown): boolean {
	return false;
}
function retryAfter(e: unknown): number {
	return 30;
}
