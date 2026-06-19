import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { handleBackupBatch } from '../src/consumer';
import type { BackupJob } from '../src/types';

const job = (tenantId: string): BackupJob => ({
	tenantId,
	runId: 'run-1',
	resource: { kind: 'mailfolder', id: 'F', ownerId: 'U' },
	cursor: null,
});

// A one-message batch with spy-able ack/retry, shaped like a real MessageBatch.
function oneMessageBatch(body: BackupJob) {
	const ack = vi.fn();
	const retry = vi.fn();
	const batch = {
		queue: 'backup-queue',
		messages: [{ id: '1', timestamp: new Date(0), body, attempts: 1, ack, retry }],
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	} as unknown as MessageBatch<BackupJob>;
	return { batch, ack, retry };
}

describe('consumer flow control (#5)', () => {
	it('re-enqueues a fresh job on token denial instead of retrying (no budget burn)', async () => {
		const tenantId = 'tenant-drain';
		const j = job(tenantId);

		// Drain the per-tenant token bucket (CAP=30) so the next takeToken denies.
		const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
		for (let i = 0; i < 35; i++) await stub.takeToken();

		const send = vi.fn();
		const testEnv = { ...env, BACKUP_QUEUE: { send, sendBatch: vi.fn() } } as unknown as Env;
		const { batch, ack, retry } = oneMessageBatch(j);

		await handleBackupBatch(batch, testEnv);

		// Flow control, not failure: fresh re-enqueue + ack, never retry (retry
		// would count toward max_retries and dead-letter healthy work).
		expect(send).toHaveBeenCalledTimes(1);
		const [sentJob, opts] = send.mock.calls[0];
		expect(sentJob).toEqual(j);
		expect(opts.delaySeconds).toBeGreaterThanOrEqual(1);
		expect(ack).toHaveBeenCalledTimes(1);
		expect(retry).not.toHaveBeenCalled();
	});

	it('falls back to retry (keeps the message) when the re-enqueue send fails', async () => {
		const tenantId = 'tenant-drain-2';
		const j = job(tenantId);

		const stub = env.TENANT.get(env.TENANT.idFromName(tenantId));
		for (let i = 0; i < 35; i++) await stub.takeToken();

		const send = vi.fn().mockRejectedValue(new Error('queue unavailable'));
		const testEnv = { ...env, BACKUP_QUEUE: { send, sendBatch: vi.fn() } } as unknown as Env;
		const { batch, ack, retry } = oneMessageBatch(j);

		await handleBackupBatch(batch, testEnv);

		// A transient send failure must not drop the message — retry keeps it alive.
		expect(send).toHaveBeenCalledTimes(1);
		expect(retry).toHaveBeenCalledTimes(1);
		expect(retry.mock.calls[0][0].delaySeconds).toBeGreaterThanOrEqual(1);
		expect(ack).not.toHaveBeenCalled();
	});
});
