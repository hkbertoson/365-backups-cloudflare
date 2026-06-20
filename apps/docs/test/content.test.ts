import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Content lint layered on top of `astro check` + `astro build`: reads the
// markdown on disk and enforces conventions the build does not — every page
// carries a non-empty title AND description, the homepage is a splash page, and
// the documented sections are all present.

const DOCS_DIR = fileURLToPath(new URL('../src/content/docs', import.meta.url));

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...walk(full));
		else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) out.push(full);
	}
	return out;
}

function frontmatter(content: string): Record<string, string> {
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return {};
	const fields: Record<string, string> = {};
	for (const line of match[1].split('\n')) {
		const kv = line.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
		if (kv) fields[kv[1]] = kv[2].trim().replace(/^['"]|['"]$/g, '');
	}
	return fields;
}

const files = walk(DOCS_DIR);
const rel = (f: string) => f.slice(DOCS_DIR.length + 1).replaceAll('\\', '/');

describe('docs content', () => {
	it('discovers the documentation pages', () => {
		expect(files.length).toBeGreaterThanOrEqual(16);
	});

	it.each(files.map((f) => [rel(f), f] as const))('%s has a non-empty title and description', (_name, file) => {
		const fm = frontmatter(readFileSync(file, 'utf8'));
		expect(fm.title, 'missing title').toBeTruthy();
		expect(fm.description, 'missing description').toBeTruthy();
	});

	it('renders the homepage as a splash page', () => {
		const fm = frontmatter(readFileSync(join(DOCS_DIR, 'index.mdx'), 'utf8'));
		expect(fm.template).toBe('splash');
	});

	it('ships every documented section', () => {
		const present = new Set(files.map(rel));
		for (const expected of [
			'getting-started.md',
			'concepts/domain-glossary.md',
			'concepts/temporal-model.md',
			'architecture/overview.md',
			'architecture/backup-workflow.md',
			'architecture/queue-consumer.md',
			'architecture/tenant-coordinator.md',
			'architecture/storage-and-catalog.md',
			'architecture/retention-and-restore.md',
			'adr/overview.md',
			'adr/multi-tenant-and-throttle-governance.md',
			'adr/resource-equals-delta-collection.md',
			'adr/per-tenant-catalog.md',
			'adr/mvp-scope.md',
			'reference/bindings.md',
			'reference/data-model.md',
			'reference/configuration.md',
		]) {
			expect(present.has(expected), `missing ${expected}`).toBe(true);
		}
	});
});
