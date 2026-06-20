import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

// https://astro.build/config
export default defineConfig({
	site: 'https://m365vault.example.com',
	integrations: [
		starlight({
			title: 'm365vault',
			description: 'A Microsoft 365 backup engine on Cloudflare.',
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/hkbertoson/365-backups-cloudflare' }],
			// Fails the build on any broken internal link or bad anchor.
			plugins: [starlightLinksValidator()],
			// Starlight >= 0.39 requires autogenerate groups to nest under `items`.
			sidebar: [
				{ label: 'Start here', items: [{ slug: 'getting-started' }] },
				{ label: 'Concepts', items: [{ autogenerate: { directory: 'concepts' } }] },
				{ label: 'Architecture', items: [{ autogenerate: { directory: 'architecture' } }] },
				{ label: 'Reference', items: [{ autogenerate: { directory: 'reference' } }] },
				{ label: 'Decisions (ADRs)', items: [{ autogenerate: { directory: 'adr' } }] },
			],
		}),
	],
});
