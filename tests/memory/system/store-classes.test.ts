import { describe, expect, it } from 'vitest';

import { MemoryKindSchema } from '../../../src/knowledge/retrieval-contracts';
import {
  ALL_STORE_CLASSES,
  DURABLE_STORE_CLASSES,
  MEMORY_STORE_POLICIES,
  kindsForStoreClass,
  policyForKind,
  storeClassForKind
} from '../../../src/memory/system/store-classes';

const ALL_KINDS = MemoryKindSchema.options;

describe('memory store classes', () => {
  it('maps every memory kind to exactly one durable store class', () => {
    for (const kind of ALL_KINDS) {
      const storeClass = storeClassForKind(kind);
      expect(DURABLE_STORE_CLASSES).toContain(storeClass);
      expect(kindsForStoreClass(storeClass)).toContain(kind);
    }
  });

  it('routes kinds following the CoALA taxonomy', () => {
    expect(storeClassForKind('episode')).toBe('episodic');
    expect(storeClassForKind('artifact')).toBe('episodic');
    expect(storeClassForKind('decision')).toBe('episodic');
    expect(storeClassForKind('fact')).toBe('semantic');
    expect(storeClassForKind('identity')).toBe('semantic');
    expect(storeClassForKind('preference')).toBe('semantic');
    expect(storeClassForKind('policy')).toBe('semantic');
    expect(storeClassForKind('summary')).toBe('semantic');
    expect(storeClassForKind('procedure')).toBe('procedural');
    expect(storeClassForKind('blueprint')).toBe('procedural');
  });

  it('partitions the kinds with no overlap across durable stores', () => {
    const seen = new Set<string>();
    for (const storeClass of DURABLE_STORE_CLASSES) {
      for (const kind of kindsForStoreClass(storeClass)) {
        expect(seen.has(kind)).toBe(false);
        seen.add(kind);
      }
    }
    expect(seen.size).toBe(ALL_KINDS.length);
  });

  it('exposes a complete, never-auto-promotable policy per store class', () => {
    for (const storeClass of ALL_STORE_CLASSES) {
      const policy = MEMORY_STORE_POLICIES[storeClass];
      expect(policy.storeClass).toBe(storeClass);
      expect(policy.autoPromotable).toBe(false);
      expect(policy.ftsWeights).toHaveLength(3);
    }
    expect(MEMORY_STORE_POLICIES.working.retention).toBe('run_local');
    expect(MEMORY_STORE_POLICIES.episodic.consolidationRole).toBe('source');
    expect(MEMORY_STORE_POLICIES.semantic.consolidationRole).toBe('target');
    expect(MEMORY_STORE_POLICIES.procedural.consolidationRole).toBe('target');
  });

  it('resolves the policy for a kind through its store class', () => {
    expect(policyForKind('episode')).toBe(MEMORY_STORE_POLICIES.episodic);
    expect(policyForKind('summary')).toBe(MEMORY_STORE_POLICIES.semantic);
    expect(policyForKind('blueprint')).toBe(MEMORY_STORE_POLICIES.procedural);
  });
});
