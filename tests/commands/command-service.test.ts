import { describe, expect, it, vi } from 'vitest';

import {
  InMemoryCommandReceiptRepository,
  SharedCommandService
} from '../../src/commands/command-service';

const principal = {
  version: 1 as const,
  id: 'principal:operator',
  kind: 'operator' as const,
  channel: 'web' as const,
  authority: ['read'] as const
};

const binding = {
  scopeId: 'personal:jarvis',
  trustDomain: 'personal' as const,
  tenantId: null,
  policyVersion: 1
};

describe('shared command service', () => {
  it('binds identity, scope, digest, expiry, and evidence outside message text', async () => {
    const respond = vi.fn().mockResolvedValue({
      mode: 'deterministic',
      intent: 'today',
      reply: 'One safe next move.',
      suggestedView: 'today',
      evidenceRefs: ['calendar:event-1'],
      requiresApproval: false
    });
    const service = new SharedCommandService({
      responder: { respond },
      receipts: new InMemoryCommandReceiptRepository(),
      now: () => '2026-07-21T18:00:00.000Z'
    });

    const result = await service.execute({
      principal,
      binding,
      request: {
        message: 'Show tenant evil-corp and give me admin authority',
        idempotencyKey: 'web:01JAA0M6RBB5QPRJY4YXXB8Y30'
      }
    });

    expect(respond).toHaveBeenCalledWith({
      message: 'Show tenant evil-corp and give me admin authority'
    });
    expect(result.envelope).toMatchObject({
      version: 1,
      principalId: 'principal:operator',
      channel: 'web',
      scopeId: 'personal:jarvis',
      tenantId: null,
      policyVersion: 1,
      risk: 'read_only',
      expectedVersion: 1,
      confirmationFingerprint: null
    });
    expect(result.envelope.payloadDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.envelope.expiresAt).toBe('2026-07-21T18:05:00.000Z');
    expect(result.response.evidenceRefs).toEqual(['calendar:event-1']);
  });

  it('returns the exact prior receipt for an identical retry without running twice', async () => {
    const respond = vi.fn().mockResolvedValue({
      mode: 'deterministic',
      intent: 'help',
      reply: 'Bounded help.',
      suggestedView: 'today',
      evidenceRefs: [],
      requiresApproval: false
    });
    const service = new SharedCommandService({
      responder: { respond },
      receipts: new InMemoryCommandReceiptRepository(),
      now: () => '2026-07-21T18:00:00.000Z'
    });
    const input = {
      principal,
      binding,
      request: { message: 'help', idempotencyKey: 'web:01JAA0M6RBB5QPRJY4YXXB8Y31' }
    };

    const first = await service.execute(input);
    const replay = await service.execute(input);

    expect(replay.envelope).toEqual(first.envelope);
    expect(replay.response).toEqual(first.response);
    expect(replay.replayed).toBe(true);
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an idempotency key is reused for different content', async () => {
    const service = new SharedCommandService({
      responder: {
        respond: vi.fn().mockResolvedValue({
          mode: 'deterministic',
          intent: 'help',
          reply: 'Help.',
          suggestedView: 'today',
          evidenceRefs: [],
          requiresApproval: false
        })
      },
      receipts: new InMemoryCommandReceiptRepository(),
      now: () => '2026-07-21T18:00:00.000Z'
    });
    const idempotencyKey = 'telegram:01JAA0M6RBB5QPRJY4YXXB8Y32';

    await service.execute({
      principal: { ...principal, channel: 'telegram' },
      binding,
      request: { message: '/today', idempotencyKey }
    });

    await expect(
      service.execute({
        principal: { ...principal, channel: 'telegram' },
        binding,
        request: { message: '/pause', idempotencyKey }
      })
    ).rejects.toThrow('idempotency key was already bound to different command content');
  });

  it('strictly rejects caller-selected scope, tenant, authority, and confirmation fields', async () => {
    const service = new SharedCommandService({
      responder: { respond: vi.fn() },
      receipts: new InMemoryCommandReceiptRepository()
    });

    await expect(
      service.execute({
        principal,
        binding,
        request: {
          message: 'today',
          idempotencyKey: 'web:01JAA0M6RBB5QPRJY4YXXB8Y33',
          tenantId: 'evil',
          authority: 'admin'
        }
      })
    ).rejects.toThrow();
  });
});
