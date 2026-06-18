export default {
	async fetch(): Promise<Response> {
		return new Response('Hello, world!');
	},
} satisfies ExportedHandler<Env, Error>;
