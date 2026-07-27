import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FlatLexicalMemorySystem } from '../../../src/memory/system/flat-lexical-system';
import {
  createMemorySystemHarness,
  EVALUATED_AT,
  fragmentInput,
  OWNER_SCOPE_ID,
  retrievalAuthorization,
  SLEEVE_ID,
  type MemorySystemHarness
} from './memory-system-harness';

describe('flat lexical memory system (backend A)', () => {
  let harness: MemorySystemHarness;
  let system: FlatLexicalMemorySystem;

  beforeEach(async () => {
    harness = await createMemorySystemHarness();
    system = new FlatLexicalMemorySystem({
      sqlite: harness.context.sqlite,
      access: harness.boundAccess
    });
  });

  afterEach(async () => {
    await harness.cleanup();
  });

  it('reports the flat capability profile with no typed stores', () => {
    expect(system.id).toBe('flat');
    expect(system.capabilities).toMatchObject({
      workingMemory: false,
      consolidation: false,
      proceduralPromotion: false
    });
    expect(system.workingMemory()).toBeNull();
    expect(system.consolidation()).toBeNull();
    expect(system.procedures()).toBeNull();
  });

  it('writes a durable fragment and retrieves it through the authorized path', async () => {
    const written = await system.write(fragmentInput('acme_close'));
    expect(written).toMatchObject({ id: 'acme_close', sleeveId: SLEEVE_ID });

    const result = await system.retrieve({
      authorization: retrievalAuthorization(harness.grantVersions),
      text: 'cobalt close',
      limit: 10
    });
    expect(result.items.map((item) => item.id)).toEqual(['acme_close']);
    expect(result.manifest.algorithm).toBe('sqlite_fts5_bm25_v1');
  });

  it('compiles a deterministic scoped context over whole fragments', () => {
    const content = 'Quarterly close uses the cobalt reconciliation checklist.';
    const compiled = system.compileContext({
      ownerScopeId: OWNER_SCOPE_ID,
      sleeveId: SLEEVE_ID,
      totalCapacityTokens: 4_000,
      reservations: { output: 100, policy: 100, toolSchema: 100, workingState: 100, safety: 100 },
      maxFragmentsPerSource: 3,
      evaluatedAt: EVALUATED_AT,
      fragments: [
        {
          id: 'acme_close',
          ownerScopeId: OWNER_SCOPE_ID,
          sleeveId: SLEEVE_ID,
          sourceId: 'note:acme_close',
          sourceHash: createHash('sha256').update('acme_close', 'utf8').digest('hex'),
          content,
          required: true,
          priority: 50,
          relevancePermille: 800,
          confidencePermille: 900,
          recordedAt: '2026-07-19T12:00:00.000Z',
          coverageKeys: ['close'],
          retrievalEligible: true,
          expiresAt: null,
          supersededByFragmentId: null
        }
      ]
    });
    expect(compiled.status).toBe('ready');
    expect(compiled.selected.map((fragment) => fragment.id)).toEqual(['acme_close']);
  });
});
