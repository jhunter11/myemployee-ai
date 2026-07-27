import { describe, expect, it } from 'vitest';

import {
  CANONICAL_IDENTITY_FIELDS,
  canonicalHash,
  canonicalRevisionForm,
  canonicalize,
  contentHash,
  MemoryCanonicalFormError,
  MemoryRevisionIntegrityError,
  verifyRevisionIntegrity
} from '../../../src/memory/ledger/canonical';
import {
  MEMORY_RECORD_SCHEMA_VERSION,
  MemoryRevisionSchema,
  type MemoryRevision
} from '../../../src/memory/ledger/record-contracts';

function revision(overrides: Record<string, unknown> = {}): MemoryRevision {
  const base = {
    schemaVersion: MEMORY_RECORD_SCHEMA_VERSION,
    recordType: 'MemoryRevision',
    memoryId: 'mem_pref_007',
    revisionId: 'rev_pref_007_b',
    revisionNo: 2,
    ownerScopeId: 'personal:jack',
    sleeveId: 'personal:jack',
    sleeveClass: 'personal',
    kind: 'preference',
    entityKey: 'operator/report_format',
    status: 'active',
    approvalState: 'approved',
    authorityTier: 'operator_explicit',
    confidencePermille: 990,
    sensitivity: 'internal',
    retentionPolicy: 'retain_until_revoked',
    legalHold: false,
    eventTime: '2026-07-24T19:00:31.000Z',
    observedAt: '2026-07-24T19:00:31.000Z',
    createdTxTime: '2026-07-24T19:01:10.000Z',
    recordedTxSeq: 12_009,
    validFrom: '2026-07-24T19:00:31.000Z',
    validUntil: null,
    decidedAt: '2026-07-24T19:01:01.000Z',
    authorAgentId: 'agency-developer',
    workflowId: 'wf_preference_capture_v3',
    runId: null,
    derivationMethod: 'explicit_operator_statement',
    sourceEventIds: ['evt_chat_8830'],
    evidenceRefs: [{ type: 'memory_revision', id: 'rev_ep_personal_441' }],
    derivedFrom: [],
    contradicts: [],
    supersedes: 'rev_pref_007_a',
    supersededBy: null,
    payloadCanonical: {
      form: 'triple',
      subject: 'operator',
      predicate: 'prefers_report_format',
      object: 'dense_narrative_with_citations',
      qualifiers: []
    },
    contentHash: `sha256:${'a'.repeat(64)}`,
    canonicalHash: `sha256:${'b'.repeat(64)}`,
    tombstone: null,
    ...overrides
  };
  return MemoryRevisionSchema.parse(base);
}

/** Re-seal a revision so its stored digests match its content. */
function sealed(overrides: Record<string, unknown> = {}): MemoryRevision {
  const draft = revision(overrides);
  const withContent = { ...draft, contentHash: contentHash(draft.payloadCanonical) };
  return { ...withContent, canonicalHash: canonicalHash(withContent) };
}

describe('canonicalize', () => {
  it('orders object keys recursively so field order cannot change a hash', () => {
    const left = { beta: { z: 1, a: 2 }, alpha: 'x' };
    const right = { alpha: 'x', beta: { a: 2, z: 1 } };
    expect(canonicalize(left)).toBe(canonicalize(right));
    expect(canonicalize(left)).toBe('{"alpha":"x","beta":{"a":2,"z":1}}');
  });

  it('sorts by UTF-16 code unit, not by locale', () => {
    // Locale collation would interleave case; code-unit order puts all uppercase first.
    expect(canonicalize({ a: 1, B: 2, A: 3, b: 4 })).toBe('{"A":3,"B":2,"a":1,"b":4}');
  });

  it('preserves array order, because order is meaning', () => {
    expect(canonicalize(['open', 'reconcile', 'sign_off'])).toBe('["open","reconcile","sign_off"]');
    expect(canonicalize(['b', 'a'])).not.toBe(canonicalize(['a', 'b']));
  });

  it('keeps null distinct from an absent key', () => {
    expect(canonicalize({ validUntil: null })).toBe('{"validUntil":null}');
    expect(canonicalize({ validUntil: null })).not.toBe(canonicalize({}));
    expect(canonicalize(null)).toBe('null');
  });

  it('encodes scalars unambiguously, including the ones JSON would quote loosely', () => {
    expect(canonicalize(true)).toBe('true');
    expect(canonicalize(false)).toBe('false');
    // A boolean and its string spelling must never collide.
    expect(canonicalize({ legalHold: true })).not.toBe(canonicalize({ legalHold: 'true' }));
    expect(canonicalize('quote"and\\slash')).toBe('"quote\\"and\\\\slash"');
    expect(canonicalize('')).toBe('""');
  });

  it('refuses undefined rather than silently dropping it', () => {
    expect(() => canonicalize(undefined)).toThrow(MemoryCanonicalFormError);
    expect(() => canonicalize({ a: undefined })).toThrow(MemoryCanonicalFormError);
    try {
      canonicalize({ a: undefined });
      expect.unreachable('undefined must not be encodable');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MEMORY_CANONICAL_FORM_INVALID',
        kind: 'undefined_value'
      });
    }
  });

  it('refuses floating-point ambiguity and normalizes negative zero', () => {
    expect(canonicalize(0)).toBe('0');
    expect(canonicalize(-0)).toBe('0');
    expect(canonicalize(-17)).toBe('-17');
    expect(() => canonicalize(0.1)).toThrow(MemoryCanonicalFormError);
    expect(() => canonicalize(Number.NaN)).toThrow(MemoryCanonicalFormError);
    expect(() => canonicalize(Number.POSITIVE_INFINITY)).toThrow(MemoryCanonicalFormError);
    expect(() => canonicalize(2 ** 53)).toThrow(MemoryCanonicalFormError);
    expect(canonicalize(Number.MAX_SAFE_INTEGER)).toBe('9007199254740991');
  });

  it('refuses values with no unambiguous encoding', () => {
    expect(() => canonicalize(new Date('2026-07-24T00:00:00.000Z'))).toThrow(
      MemoryCanonicalFormError
    );
    expect(() => canonicalize(new Map())).toThrow(MemoryCanonicalFormError);
    expect(() => canonicalize(() => 1)).toThrow(MemoryCanonicalFormError);
    expect(() => canonicalize(10n)).toThrow(MemoryCanonicalFormError);
    expect(() => canonicalize({ [Symbol('s')]: 1 })).toThrow(MemoryCanonicalFormError);
    // A null-prototype bag is still a plain record of data.
    expect(canonicalize(Object.assign(Object.create(null), { a: 1 }))).toBe('{"a":1}');
  });

  it('bounds recursion depth instead of blowing the stack on hostile input', () => {
    let deep: unknown = 1;
    for (let index = 0; index < 40; index += 1) {
      deep = { nested: deep };
    }
    expect(() => canonicalize(deep)).toThrow(MemoryCanonicalFormError);
    try {
      canonicalize(deep);
      expect.unreachable('deep nesting must be rejected');
    } catch (error) {
      expect(error).toMatchObject({ kind: 'depth_exceeded' });
    }
    let shallow: unknown = 1;
    for (let index = 0; index < 8; index += 1) {
      shallow = { nested: shallow };
    }
    expect(() => canonicalize(shallow)).not.toThrow();
  });
});

describe('contentHash', () => {
  it('is stable across payload field order and sensitive to every value', () => {
    const left = contentHash({
      form: 'structured',
      fields: { channel: 'meeting_transcript', turns: 12 }
    });
    const right = contentHash({
      form: 'structured',
      fields: { turns: 12, channel: 'meeting_transcript' }
    });
    expect(left).toBe(right);
    expect(left).toMatch(/^sha256:[a-f0-9]{64}$/);

    const changed = contentHash({
      form: 'structured',
      fields: { channel: 'meeting_transcript', turns: 13 }
    });
    expect(changed).not.toBe(left);
  });

  it('separates claims that differ only in qualifier context', () => {
    const base = {
      form: 'triple',
      subject: 'operator',
      predicate: 'prefers_theme',
      object: 'dark_mode'
    } as const;
    expect(contentHash({ ...base, qualifiers: [] })).not.toBe(
      contentHash({ ...base, qualifiers: ['channel_email'] })
    );
  });
});

describe('canonicalHash', () => {
  it('hashes exactly the declared identity-bearing fields', () => {
    const form: unknown = JSON.parse(canonicalRevisionForm(revision()));
    expect(typeof form).toBe('object');
    const keys = Object.keys(form as Record<string, unknown>);
    expect(keys).toEqual([...CANONICAL_IDENTITY_FIELDS].sort());
  });

  it('is identical when only field ORDER differs', () => {
    const ordered = revision({
      payloadCanonical: {
        form: 'structured',
        fields: { alpha: 'one', beta: 'two', gamma: 3 }
      },
      entityKey: null,
      kind: 'episode'
    });
    const reordered = revision({
      payloadCanonical: {
        form: 'structured',
        fields: { gamma: 3, beta: 'two', alpha: 'one' }
      },
      entityKey: null,
      kind: 'episode'
    });
    expect(canonicalHash(ordered)).toBe(canonicalHash(reordered));
    // Set-valued provenance lists are order-insensitive by the same argument.
    expect(canonicalHash(revision({ derivedFrom: ['mem_a', 'mem_b'] }))).toBe(
      canonicalHash(revision({ derivedFrom: ['mem_b', 'mem_a'] }))
    );
    expect(canonicalHash(revision({ sourceEventIds: ['evt_one', 'evt_two'] }))).toBe(
      canonicalHash(revision({ sourceEventIds: ['evt_two', 'evt_one'] }))
    );
  });

  it('changes when any identity-bearing VALUE changes', () => {
    const baseline = canonicalHash(revision());
    const mutations: Record<string, unknown>[] = [
      { memoryId: 'mem_pref_008' },
      { revisionId: 'rev_pref_007_c' },
      { revisionNo: 3 },
      { ownerScopeId: 'agency:studio_ops' },
      { sleeveId: 'agency:studio_ops', sleeveClass: 'agency' },
      { kind: 'fact' },
      { entityKey: 'operator/theme_preference' },
      { eventTime: null },
      { observedAt: '2026-07-24T19:00:30.000Z' },
      { createdTxTime: '2026-07-24T19:01:11.000Z' },
      { recordedTxSeq: 12_010 },
      { validFrom: '2026-07-24T19:00:30.000Z' },
      { validUntil: '2027-01-01T00:00:00.000Z' },
      { authorityTier: 'policy_signed_approved' },
      { authorAgentId: 'agency-analyst' },
      { derivationMethod: 'human_authored_artifact_plus_operator_approval' },
      { supersedes: 'rev_pref_007_z' },
      { derivedFrom: ['mem_ep_001'] },
      { sourceEventIds: ['evt_chat_8831'] },
      {
        payloadCanonical: {
          form: 'triple',
          subject: 'operator',
          predicate: 'prefers_report_format',
          object: 'terse_bullets',
          qualifiers: []
        }
      }
    ];
    const hashes = mutations.map((mutation) => canonicalHash(revision(mutation)));
    for (const [index, hash] of hashes.entries()) {
      expect(hash, `mutation ${index} must change the canonical hash`).not.toBe(baseline);
    }
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it('is stable across acceptance metadata, so re-approval does not churn the digest', () => {
    const baseline = canonicalHash(revision());
    // UPDATE-class changes: approval, retention, sensitivity, confidence, holds, links.
    expect(canonicalHash(revision({ confidencePermille: 500 }))).toBe(baseline);
    expect(canonicalHash(revision({ sensitivity: 'restricted' }))).toBe(baseline);
    expect(canonicalHash(revision({ retentionPolicy: 'until_replaced' }))).toBe(baseline);
    expect(canonicalHash(revision({ legalHold: true }))).toBe(baseline);
    expect(canonicalHash(revision({ status: 'superseded', supersededBy: 'rev_pref_007_c' }))).toBe(
      baseline
    );
    expect(
      canonicalHash(revision({ approvalState: 'reviewed', decidedAt: '2026-07-24T19:01:00.000Z' }))
    ).toBe(baseline);
    expect(canonicalHash(revision({ workflowId: null }))).toBe(baseline);
  });

  it('is deterministic across repeated evaluation', () => {
    const subject = revision();
    expect(canonicalHash(subject)).toBe(canonicalHash(subject));
    expect(canonicalHash(revision())).toBe(canonicalHash(revision()));
  });
});

describe('verifyRevisionIntegrity', () => {
  it('accepts a correctly sealed revision', () => {
    expect(() => verifyRevisionIntegrity(sealed())).not.toThrow();
  });

  it('rejects a tampered payload and a forged canonical hash', () => {
    const good = sealed();
    const tamperedPayload: MemoryRevision = {
      ...good,
      payloadCanonical: {
        form: 'triple',
        subject: 'operator',
        predicate: 'prefers_report_format',
        object: 'terse_bullets',
        qualifiers: []
      }
    };
    expect(() => verifyRevisionIntegrity(tamperedPayload)).toThrow(MemoryRevisionIntegrityError);
    try {
      verifyRevisionIntegrity(tamperedPayload);
      expect.unreachable('tampered payload must be rejected');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MEMORY_REVISION_INTEGRITY_INVALID',
        statusCode: 409,
        field: 'contentHash',
        revisionId: 'rev_pref_007_b'
      });
    }

    const forged: MemoryRevision = { ...good, canonicalHash: `sha256:${'c'.repeat(64)}` };
    try {
      verifyRevisionIntegrity(forged);
      expect.unreachable('forged canonical hash must be rejected');
    } catch (error) {
      expect(error).toMatchObject({ field: 'canonicalHash' });
    }
  });

  it('catches an identity edit that leaves the payload untouched', () => {
    const good = sealed();
    // Re-dating validity without re-sealing is exactly the silent-rewrite the
    // ledger exists to make impossible.
    const backdated: MemoryRevision = { ...good, validFrom: '2020-01-01T00:00:00.000Z' };
    expect(() => verifyRevisionIntegrity(backdated)).toThrow(MemoryRevisionIntegrityError);
  });
});
