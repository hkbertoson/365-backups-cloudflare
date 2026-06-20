import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupWorkflow } from '../src/workflow';
import type { Resource } from '../src/types';

// Pure unit test of BackupWorkflow.run with hand-rolled fakes — no real DO,
// queue, or Graph. The graph module is mocked so discovery returns fixed scope:
// users(1) + sites(1) + folders(1) => scope = [...folders, ...sites] (length 2).
vi.mock('../src/graph', () => ({
	createGraphClient: () => ({
		listUsers: async () => ['u1'],
		listSites: async (): Promise<Resource[]> => [{ kind: 'site', id: 's1' }],
		listMailFolders: async (): Promise<Resource[]> => [{ kind: 'mailfolder', id: 'msgfolderroot', ownerId: 'u1' }],
	}),
}));

// step.do(name, a, b): a is either the closure (2-arg) or config (3-arg). Run the
// closure inline so the workflow body executes synchronously. step.sleep is a
// no-op so the drain loop never blocks.
const fakeStep = {
	do: async (_name: string, a: unknown, b?: unknown) => {
		const fn = (typeof a === 'function' ? a : b) as (() => Promise<unknown>) | undefined;
		return fn ? await fn() : undefined;
	},
	sleep: async () => {},
};

const event = { payload: { tenantId: 't1' } };

type Coordinator = ReturnType<typeof makeCoordinator>;

function makeCoordinator() {
	return {
		acquireLease: vi.fn(async () => ({ acquired: true })),
		openRun: vi.fn(async () => 'run-1'),
		setOutstanding: vi.fn(async () => {}),
		outstanding: vi.fn(async () => 0),
		finalizeRun: vi.fn(async () => {}),
		releaseLease: vi.fn(async () => {}),
	};
}

function makeEnv(coordinator: Coordinator) {
	return {
		TENANT: { idFromName: (n: string) => n, get: () => coordinator },
		BACKUP_QUEUE: { send: vi.fn(async () => {}) },
		DB: { prepare: () => ({ bind: () => ({ first: async () => 30 }) }) },
	};
}

function makeWorkflow(coordinator: Coordinator) {
	const wf = Object.create(BackupWorkflow.prototype) as BackupWorkflow;
	// biome-ignore lint/suspicious/noExplicitAny: bypass the WorkflowEntrypoint ctor for a pure unit test
	(wf as any).env = makeEnv(coordinator);
	return wf;
}

describe('BackupWorkflow.run (hand-rolled fakes)', () => {
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => vi.clearAllMocks());

	it('bails before opening a run when the lease is not acquired', async () => {
		const coordinator = makeCoordinator();
		coordinator.acquireLease.mockResolvedValue({ acquired: false });
		const wf = makeWorkflow(coordinator);

		// biome-ignore lint/suspicious/noExplicitAny: minimal fakes for event/step
		await wf.run(event as any, fakeStep as any);

		expect(coordinator.acquireLease).toHaveBeenCalledTimes(1);
		expect(coordinator.openRun).not.toHaveBeenCalled();
		// The early `if (!acquired) return` sits before the try/finally, so the
		// queue is never touched and finalize/release never run.
		expect(coordinator.setOutstanding).not.toHaveBeenCalled();
		expect(coordinator.finalizeRun).not.toHaveBeenCalled();
		expect(coordinator.releaseLease).not.toHaveBeenCalled();
	});

	it('discovers scope, fans out one job per resource, finalizes and releases', async () => {
		const coordinator = makeCoordinator();
		const wf = makeWorkflow(coordinator);
		const fakeEnv = makeEnv(coordinator);
		// biome-ignore lint/suspicious/noExplicitAny: inject the env carrying the spied queue
		(wf as any).env = fakeEnv;

		// biome-ignore lint/suspicious/noExplicitAny: minimal fakes for event/step
		await wf.run(event as any, fakeStep as any);

		// scope = [...folders(1), ...sites(1)] => 2; retention 30 from env.DB.
		expect(coordinator.openRun).toHaveBeenCalledTimes(1);
		expect(coordinator.openRun).toHaveBeenCalledWith('incremental', 2, 30);
		expect(coordinator.setOutstanding).toHaveBeenCalledWith(2);

		const send = fakeEnv.BACKUP_QUEUE.send;
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledWith({
			tenantId: 't1',
			runId: 'run-1',
			resource: { kind: 'mailfolder', id: 'msgfolderroot', ownerId: 'u1' },
			cursor: null,
		});
		expect(send).toHaveBeenCalledWith({
			tenantId: 't1',
			runId: 'run-1',
			resource: { kind: 'site', id: 's1' },
			cursor: null,
		});

		// outstanding() returned 0 immediately, so the drain loop never iterated.
		expect(coordinator.outstanding).toHaveBeenCalledTimes(1);
		expect(coordinator.finalizeRun).toHaveBeenCalledTimes(1);
		expect(coordinator.finalizeRun).toHaveBeenCalledWith('run-1');
		expect(coordinator.releaseLease).toHaveBeenCalledTimes(1);
	});

	it('drains: polls outstanding until it hits 0, then finalizes', async () => {
		const coordinator = makeCoordinator();
		// First poll still has work, second poll is drained — fakeStep.sleep is a
		// no-op so the while loop spins without hanging.
		coordinator.outstanding.mockResolvedValueOnce(2).mockResolvedValueOnce(0);
		const wf = makeWorkflow(coordinator);

		// biome-ignore lint/suspicious/noExplicitAny: minimal fakes for event/step
		await wf.run(event as any, fakeStep as any);

		expect(coordinator.outstanding).toHaveBeenCalledTimes(2);
		expect(coordinator.finalizeRun).toHaveBeenCalledTimes(1);
		expect(coordinator.finalizeRun).toHaveBeenCalledWith('run-1');
		expect(coordinator.releaseLease).toHaveBeenCalledTimes(1);
	});
});
