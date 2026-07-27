import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const skillRoot = join(__dirname, '..', '..', 'skills', 'jarvis-page-builder');

async function read(relativePath: string): Promise<string> {
  return readFile(join(skillRoot, relativePath), 'utf8');
}

const normalized = (value: string): string => value.replace(/\s+/g, ' ');

describe('jarvis page builder skill', () => {
  it('triggers explicitly for create, add, or build Jarvis dashboard page requests', async () => {
    const skill = await read('SKILL.md');
    const frontmatter = skill.slice(0, skill.indexOf('---', 4) + 3);

    expect(frontmatter).toContain('name: jarvis-page-builder');
    for (const trigger of ['create', 'add', 'build', 'Jarvis dashboard page']) {
      expect(frontmatter.toLowerCase()).toContain(trigger.toLowerCase());
    }
  });

  it('maps the request to code and chooses Page Studio or TDD repository work without a partial page', async () => {
    const skill = normalized(await read('SKILL.md'));

    expect(skill).toContain('Inspect the request, current code, and bounded read models');
    expect(skill).toContain('supported widgets');
    expect(skill).toContain('capability gaps');
    expect(skill).toContain('declarative Page Studio');
    expect(skill).toContain('TDD repository implementation');
    expect(skill).toContain('Do not publish a partial page');
    expect(skill).toContain('queue as its own default page');
    expect(skill).toContain('/dashboard?view=queue');
  });

  it('locks scope, data, mutation, outbound action, and browser verification invariants', async () => {
    const skill = normalized(await read('SKILL.md'));

    for (const invariant of [
      'fixed same-origin bounded DTOs',
      'loopback-only mutations',
      'exact registered client or project scope',
      'tenant-private data',
      'Never auto-send, pay, deploy',
      'desktop and mobile',
      'console errors',
      'document overflow'
    ]) {
      expect(skill).toContain(invariant);
    }
  });

  it('keeps the current widget/API contract in one progressive reference', async () => {
    const [skill, contract, references] = await Promise.all([
      read('SKILL.md'),
      read('references/page-contract.md'),
      readdir(join(skillRoot, 'references'))
    ]);

    expect(skill).toContain('references/page-contract.md');
    expect(references).toEqual(['page-contract.md']);
    for (const widget of [
      'health',
      'clients',
      'recent-runs',
      'attention',
      'toolsmith',
      'memory-graph',
      'model-economics'
    ]) {
      expect(contract).toContain(`\`${widget}\``);
    }
    for (const endpoint of [
      '/api/v1/dashboard/overview',
      '/api/v1/dashboard/queue',
      '/api/v1/dashboard/revenue',
      '/api/v1/dashboard/graph',
      '/api/v1/dashboard/pages'
    ]) {
      expect(contract).toContain(endpoint);
    }
  });

  it('uses generated, skill-specific UI metadata', async () => {
    const metadata = await read('agents/openai.yaml');

    expect(metadata).toMatch(/display_name:\s*['"]Jarvis Page Builder['"]/);
    expect(metadata).toMatch(/short_description:\s*['"]Build verified Jarvis dashboard pages['"]/);
    expect(metadata).toContain('$jarvis-page-builder');
  });
});
