declare module 'cloudflare:test' {
	// Bindings exposed to tests come from wrangler.jsonc — same shape as Env.
	interface ProvidedEnv extends Env {}
}
