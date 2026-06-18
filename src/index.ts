import { handleBackupBatch } from './consumer';
import { runRetention } from './retention';
import type { BackupJob } from './types';

// Re-export the Workflow + Durable Object classes so the runtime can find
// them (their bindings reference these class names in wrangler.jsonc).
export { TenantCoordinator } from './coordinator';
export { BackupWorkflow } from './workflow';

// Weekly retention/GC cron (distinct from the daily backup cron).
const RETENTION_CRON = '0 4 * * 0';

export default {
	// Cron — the daily backup cron starts one Workflow per enabled tenant;
	// the weekly retention cron runs garbage collection.
	async scheduled(controller: ScheduledController, env: Env): Promise<void> {
		if (controller.cron === RETENTION_CRON) {
			await runRetention(env);
			return;
		}

		// env.DB is the control-plane registry (only the `tenants` table); each
		// tenant's catalog lives in its TenantCoordinator DO SQLite (ADR 0003).
		const { results } = await env.DB.prepare('SELECT tenant_id FROM tenants WHERE backup_enabled = 1').all<{ tenant_id: string }>();

		for (const { tenant_id } of results) {
			await env.BACKUP_WORKFLOW.create({ params: { tenantId: tenant_id } });
		}
	},

	// Queue consumer — the per-resource backup worker.
	async queue(batch: MessageBatch<BackupJob>, env: Env): Promise<void> {
		await handleBackupBatch(batch, env);
	},

	// Minimal HTTP surface (health / future admin API).
	async fetch(): Promise<Response> {
		return new Response('m365vault', { status: 200 });
	},
} satisfies ExportedHandler<Env, BackupJob>;
