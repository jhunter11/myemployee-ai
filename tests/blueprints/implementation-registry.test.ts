import { describe, expect, it } from 'vitest';

import { BlueprintImplementationRegistry } from '../../src/blueprints/implementation-registry';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);

describe('BlueprintImplementationRegistry', () => {
  it('resolves only implementation digests fixed at construction time', () => {
    const registry = new BlueprintImplementationRegistry([
      { implementationId: 'daily_report_v1', digest: DIGEST_A }
    ]);

    expect(registry.resolve(DIGEST_A)).toEqual({
      implementationId: 'daily_report_v1',
      digest: DIGEST_A
    });
    expect(() => registry.resolve(DIGEST_B)).toThrowError(/not statically registered/i);
    expect('register' in registry).toBe(false);
  });

  it('rejects invalid and duplicate static registrations', () => {
    expect(
      () =>
        new BlueprintImplementationRegistry([
          { implementationId: 'daily_report_v1', digest: DIGEST_A },
          { implementationId: 'another_worker', digest: DIGEST_A }
        ])
    ).toThrowError(/digest.*already registered/i);
    expect(
      () =>
        new BlueprintImplementationRegistry([
          { implementationId: 'daily_report_v1', digest: DIGEST_A },
          { implementationId: 'daily_report_v1', digest: DIGEST_B }
        ])
    ).toThrowError(/implementation.*already registered/i);
    expect(
      () =>
        new BlueprintImplementationRegistry([
          { implementationId: '../runtime-code', digest: 'not-a-digest' }
        ])
    ).toThrow();
  });
});
