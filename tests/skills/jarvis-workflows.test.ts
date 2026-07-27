import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const skillRoot = join(__dirname, '..', '..', 'skills', 'jarvis-workflows');

async function read(relativePath: string): Promise<string> {
  return readFile(join(skillRoot, relativePath), 'utf8');
}

describe('jarvis workflow skill router', () => {
  it('routes every operational trigger lane through progressive references', async () => {
    const skill = await read('SKILL.md');

    for (const reference of [
      'page.md',
      'memory.md',
      'automation.md',
      'economics.md',
      'queue.md',
      'revenue.md',
      'operations.md'
    ]) {
      expect(skill).toContain(`references/${reference}`);
    }
    for (const trigger of ['Graphify', 'priority queue', 'outreach', 'x402', 'caffeinate']) {
      expect(skill).toContain(trigger);
    }
  });

  it('keeps knowledge, queue, revenue, and runtime workflows fail closed', async () => {
    const [memory, queue, revenue, operations] = await Promise.all([
      read('references/memory.md'),
      read('references/queue.md'),
      read('references/revenue.md'),
      read('references/operations.md')
    ]);
    const normalize = (value: string) => value.replace(/\s+/g, ' ');

    expect(normalize(memory)).toContain('GRAPHIFY_QUERY_LOG_DISABLE=1');
    expect(normalize(memory)).toContain('Never expose Graphify MCP or `project_path`');
    expect(normalize(memory)).toContain('exact registered graph partition');
    expect(normalize(queue)).toContain('Never accept a tenant selector from the operator browser');
    expect(normalize(queue)).toContain('payloads and leases worker-only');
    expect(normalize(revenue)).toContain('Never send outreach');
    expect(normalize(revenue)).toContain('mainnet remains blocked');
    expect(normalize(operations)).toContain('loopback-only');
    expect(normalize(operations)).toContain('Remote access remains disabled');
  });
});
