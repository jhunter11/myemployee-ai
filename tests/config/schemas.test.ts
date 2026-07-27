import { describe, expect, it } from 'vitest';

import {
  AgentRunSchema,
  ClientProfileSchema,
  ClientConfigSchema,
  EscalationEventSchema,
  RunIdSchema,
  ToolPolicySchema
} from '../../src/config/schemas';

describe('ClientProfileSchema', () => {
  it('accepts the deny-network offline compute profile', () => {
    expect(ClientProfileSchema.parse('offline_compute')).toBe('offline_compute');
  });
});

describe('ClientConfigSchema', () => {
  const validConfig = {
    id: 'acme_corp',
    name: 'Acme Corporation',
    profile: 'data_processing',
    createdAt: '2026-07-18T12:00:00.000Z',
    workspacePath: '/tmp/workspaces/acme_corp',
    clientDirectory: '/tmp/clients/acme_corp',
    databasePath: '/tmp/clients/acme_corp/memory/client.sqlite'
  };

  it('parses a valid client and supplies active status', () => {
    expect(ClientConfigSchema.parse(validConfig)).toEqual({
      ...validConfig,
      status: 'active'
    });
  });

  it.each(['../acme', 'Acme', 'a', 'acme-corp', '/tmp/acme'])('rejects unsafe id %s', (id) => {
    expect(ClientConfigSchema.safeParse({ ...validConfig, id }).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(ClientConfigSchema.safeParse({ ...validConfig, secret: 'leak' }).success).toBe(false);
  });
});

describe('AgentRunSchema', () => {
  it('accepts opaque safe run ids and rejects path syntax', () => {
    expect(RunIdSchema.parse('018f-run_01')).toBe('018f-run_01');
    expect(() => RunIdSchema.parse('../run-01')).toThrow();
    expect(() => RunIdSchema.parse('run/01')).toThrow();
    expect(() => RunIdSchema.parse('.hidden')).toThrow();
  });

  it('accepts a completed run with JSON input and output', () => {
    const result = AgentRunSchema.parse({
      id: 'run-1',
      clientId: 'acme_corp',
      automation: 'daily-report',
      status: 'succeeded',
      input: { status: 'qualified' },
      output: { count: 4, ids: ['lead_1'] },
      errorMessage: null,
      parentRunId: null,
      workerId: 'acme_corp:daily-report',
      startedAt: '2026-07-18T12:00:00.000Z',
      completedAt: '2026-07-18T12:00:01.000Z'
    });

    expect(result.status).toBe('succeeded');
    expect(result.output).toEqual({ count: 4, ids: ['lead_1'] });
  });

  it('rejects unknown run states', () => {
    expect(
      AgentRunSchema.safeParse({
        id: 'run-1',
        clientId: 'acme_corp',
        automation: 'daily-report',
        status: 'done',
        startedAt: '2026-07-18T12:00:00.000Z'
      }).success
    ).toBe(false);
  });
});

describe('EscalationEventSchema', () => {
  it('parses a P1 automation failure event', () => {
    const event = EscalationEventSchema.parse({
      severity: 'P1',
      clientId: 'acme_corp',
      runId: 'run-1',
      eventDescription: 'daily-report failed',
      actions: ['Log to Kanban under Automated Bug Reports'],
      resolved: false,
      timestamp: '2026-07-18T12:00:01.000Z'
    });

    expect(event.severity).toBe('P1');
  });

  it('rejects an undefined severity', () => {
    expect(
      EscalationEventSchema.safeParse({
        severity: 'P4',
        eventDescription: 'unknown',
        actions: [],
        resolved: false,
        timestamp: '2026-07-18T12:00:01.000Z'
      }).success
    ).toBe(false);
  });
});

describe('ToolPolicySchema', () => {
  it('parses the data-processing policy shape used by the blueprint', () => {
    expect(
      ToolPolicySchema.parse({
        description: 'Local data processing',
        tools_allow: ['read', 'write', 'exec'],
        tools_deny: ['process'],
        exec_scope: 'python3,node',
        requires_elevated_approval: false
      })
    ).toMatchObject({ tools_allow: ['read', 'write', 'exec'] });
  });

  it('rejects tools present in both allow and deny lists', () => {
    expect(
      ToolPolicySchema.safeParse({
        description: 'Conflicting policy',
        tools_allow: ['exec'],
        tools_deny: ['exec'],
        requires_elevated_approval: false
      }).success
    ).toBe(false);
  });

  it('requires an approval record for elevated policies', () => {
    expect(
      ToolPolicySchema.safeParse({
        description: 'Elevated policy',
        tools_allow: ['process'],
        tools_deny: [],
        requires_elevated_approval: true
      }).success
    ).toBe(false);
  });
});
