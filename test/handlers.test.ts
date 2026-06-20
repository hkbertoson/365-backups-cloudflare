import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleBackupBatch } from '../src/consumer';
import worker from '../src/index';
import { runRetention } from '../src/retention';
import type { BackupJob } from '../src/types';

// Isolate the cron/queue side effects so these tests exercise only the
// top-level handler routing, not the real consumer/retention machinery.
vi.mock('../src/consumer', () => ({ handleBackupBatch: vi.fn(async () => {}) }));
vi.mock('../src/retention', () => ({ runRetention: vi.fn(async () => ({ versionsExpired: 0, blobsDeleted: 0, bytesReclaimed: 0 })) }));

const BACKUP_CRON = '0 3 * * *';
const RETENTION_CRON = '0 4 * * 0';

const createTenantsTable = () =>
	env.DB.prepare(
		`CREATE TABLE IF NOT EXISTS tenants (
			tenant_id TEXT PRIMARY KEY,
			display_name TEXT NOT NULL,
			backup_enabled INTEGER NOT NULL DEFAULT 1,
			schedule_cron TEXT,
			retention_days INTEGER NOT NULL DEFAULT 90,
			last_run_id TEXT,
			last_run_at INTEGER,
			created_at INTEGER NOT NULL,
			updated_at INTEGER NOT NULL
		)`,
	).run();

const insertTenant = (tenantId: string, backupEnabled: number) =>
	env.DB.prepare(
		'INSERT INTO tenants (tenant_id, display_name, backup_enabled, retention_days, created_at, updated_at) VALUES (?, ?, ?, 90, 0, 0)',
	)
		.bind(tenantId, tenantId, backupEnabled)
		.run();

describe('worker handler (src/index)', () => {
	afterEach(() => vi.clearAllMocks());

	it('fetch returns the health string', async () => {
		const ctx = createExecutionContext();
		const res = await worker.fetch(new Request('http://x/'), env, ctx);
		await waitOnExecutionContext(ctx);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('m365vault');
	});

	it('backup cron starts one workflow per enabled tenant only', async () => {
		await createTenantsTable();
		// Storage is not reset between tests in this pool, so clear any rows from
		// a prior run before seeding — keeps the toHaveBeenCalledTimes(2) exact.
		await env.DB.prepare('DELETE FROM tenants').run();
		await insertTenant('t-a', 1);
		await insertTenant('t-b', 1);
		await insertTenant('t-c', 0);

		const create = vi.fn(async () => ({ id: 'wf' }));
		const testEnv = { ...env, BACKUP_WORKFLOW: { create } } as unknown as Env;
		const ctx = createExecutionContext();

		await worker.scheduled({ cron: BACKUP_CRON } as ScheduledController, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(create).toHaveBeenCalledTimes(2);
		const tenantIds = create.mock.calls.map(([arg]) => (arg as { params: { tenantId: string } }).params.tenantId).sort();
		expect(tenantIds).toEqual(['t-a', 't-b']);
		for (const [arg] of create.mock.calls) {
			expect(arg).toEqual({ params: { tenantId: (arg as { params: { tenantId: string } }).params.tenantId } });
		}
		expect(runRetention).not.toHaveBeenCalled();
	});

	it('retention cron runs GC and starts no workflows', async () => {
		const create = vi.fn(async () => ({ id: 'wf' }));
		const testEnv = { ...env, BACKUP_WORKFLOW: { create } } as unknown as Env;
		const ctx = createExecutionContext();

		await worker.scheduled({ cron: RETENTION_CRON } as ScheduledController, testEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(runRetention).toHaveBeenCalledTimes(1);
		// Assert by identity — env carries DO service stubs that can't be structurally
		// cloned for a toHaveBeenCalledWith diff.
		expect(vi.mocked(runRetention).mock.calls[0][0]).toBe(testEnv);
		expect(create).not.toHaveBeenCalled();
	});

	it('queue delegates the batch to handleBackupBatch', async () => {
		const ctx = createExecutionContext();
		const batch = { queue: 'backup-queue', messages: [] } as unknown as MessageBatch<BackupJob>;

		await worker.queue(batch, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(handleBackupBatch).toHaveBeenCalledTimes(1);
		const [calledBatch, calledEnv] = vi.mocked(handleBackupBatch).mock.calls[0];
		expect(calledBatch).toBe(batch);
		expect(calledEnv).toBe(env);
	});
});
