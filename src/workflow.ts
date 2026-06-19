import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { createGraphClient } from './graph';
import { type Resource, tenantStub } from './types';

// ============================================================
// BackupWorkflow — the per-run "brain". Durable + resumable: each step.do()
// checkpoints, so a crash resumes from the last completed step.
// Flow: acquire lease -> discover scope -> open run -> fan out -> drain ->
// finalize -> release lease.
// ============================================================
export type BackupWorkflowParams = { tenantId: string };

export class BackupWorkflow extends WorkflowEntrypoint<Env, BackupWorkflowParams> {
	async run(event: WorkflowEvent<BackupWorkflowParams>, step: WorkflowStep): Promise<void> {
		const { tenantId } = event.payload;
		const coordinator = tenantStub(this.env, tenantId);

		// One run per tenant. If a run is already in flight, bail cleanly.
		const acquired = await step.do('acquire-lease', async () => {
			const lease = await coordinator.acquireLease();
			return lease.acquired;
		});
		if (!acquired) return;

		try {
			// One client for the whole run so the in-memory token cache is shared
			// across the discovery steps within an invocation.
			const graph = createGraphClient(this.env);
			const users = await step.do('discover-users', () => graph.listUsers(tenantId));
			const sites = await step.do('discover-sites', () => graph.listSites(tenantId));

			// One step per mailbox so each folder-tree walk gets its own subrequest
			// budget — a single combined step would exceed the ~1,000/invocation
			// limit at the ~300-mailbox ceiling. Resources accumulate across steps,
			// so scope.length is known before open-run and the completion counter
			// needs no change. (Past ~1k mailboxes, move discovery to a queue —
			// that needs increment-on-discover counting, deferred.)
			const folders: Resource[] = [];
			for (const userId of users) {
				const f = await step.do(`discover-folders:${userId}`, () => graph.listMailFolders(tenantId, userId));
				folders.push(...f);
			}

			const scope: Resource[] = [...folders, ...sites];

			const runId = await step.do('open-run', async () => {
				// retention_days lives in the control-plane registry (env.DB); the
				// catalog (and the run row) lives in the tenant's DO.
				// A missing tenant row would yield null; fall back to a safe minimum
				// rather than 0, which would set expiresAt == startedAt and make the
				// run GC-eligible the instant it opens.
				const retentionDays =
					(await this.env.DB.prepare('SELECT retention_days FROM tenants WHERE tenant_id = ?')
						.bind(tenantId)
						.first<number>('retention_days')) ?? 30;
				return coordinator.openRun('incremental', scope.length, retentionDays);
			});
			await step.do('prime-counter', () => coordinator.setOutstanding(scope.length));

			// Fan out one queue job per resource. cursor:null => stored delta link.
			await step.do('fan-out', async () => {
				for (const resource of scope) {
					await this.env.BACKUP_QUEUE.send({
						tenantId,
						runId,
						resource,
						cursor: null,
					});
				}
			});

			// Wait for consumers to drain. Sleeping cheaply between polls keeps
			// multi-hour seeds within Workflow limits.
			while ((await coordinator.outstanding()) > 0) {
				await step.sleep('await-drain', '30 seconds');
			}

			await step.do('finalize', () => coordinator.finalizeRun(runId));
		} finally {
			await step.do('release-lease', () => coordinator.releaseLease());
		}
	}
}
