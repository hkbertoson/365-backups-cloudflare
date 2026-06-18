import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Runs tests inside the Workers runtime (workerd) with the project's bindings
// simulated locally by Miniflare, so Durable Objects + their SQLite behave as
// in production. Bindings are read from wrangler.jsonc; placeholder remote ids
// (database_id, store_id, ...) are irrelevant since storage is local.
// (.mts so Vite loads this ESM-only plugin as a native module, not via require.)
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: './wrangler.jsonc' },
		}),
	],
});
