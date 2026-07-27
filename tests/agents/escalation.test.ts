import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EscalationPolicy } from '../../src/agents/escalation';

const projectRoot = join(__dirname, '..', '..');
const now = '2026-07-18T12:00:01.000Z';

describe('EscalationPolicy', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    vi.unstubAllGlobals();
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  it('classifies an automation failure as P1 using the configured actions', async () => {
    const policy = await EscalationPolicy.load({ projectRoot });

    const event = policy.classifyAutomationFailure({
      clientId: 'acme_corp',
      runId: 'run-20260718-001',
      automation: 'daily-report',
      error: new Error('CSV input unavailable'),
      timestamp: now
    });

    expect(event).toEqual({
      severity: 'P1',
      clientId: 'acme_corp',
      runId: 'run-20260718-001',
      eventDescription: 'Automation daily-report failed: CSV input unavailable',
      actions: [
        'Auto-patch if confidence > 90%',
        'Open PR with detailed diff and test results',
        'Send Telegram summary with PR link',
        'Log to Kanban under Automated Bug Reports'
      ],
      resolved: false,
      timestamp: now
    });
  });

  it('only classifies the event and performs no notification side effects', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const policy = await EscalationPolicy.load({ projectRoot });

    policy.classifyAutomationFailure({
      clientId: 'acme_corp',
      runId: 'run-20260718-002',
      automation: 'daily-report',
      error: 'worker rejected input',
      timestamp: now
    });

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['../run-01', 'run/01', '.hidden'])('rejects unsafe run id %s', async (runId) => {
    const policy = await EscalationPolicy.load({ projectRoot });

    expect(() =>
      policy.classifyAutomationFailure({
        clientId: 'acme_corp',
        runId,
        automation: 'daily-report',
        error: new Error('failed'),
        timestamp: now
      })
    ).toThrow();
  });

  it.each([
    ['invalid JSON', '{not-json'],
    [
      'a missing P1 action list',
      JSON.stringify({
        version: '1.0',
        description: 'Incomplete policy',
        severities: { P1: { label: 'High' } }
      })
    ],
    [
      'unknown configuration fields',
      JSON.stringify({
        version: '1.0',
        description: 'Untrusted policy',
        severities: {},
        escalation_channels: {},
        fallback: 'none',
        execute: '../../notify.ts'
      })
    ]
  ])('fails closed for %s', async (_description, contents) => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-escalation-test-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'escalation-policy.json'), contents);

    await expect(EscalationPolicy.load({ projectRoot: root })).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_ESCALATION_POLICY',
      message: 'Escalation policy configuration is invalid'
    });
  });

  it('fails closed when the policy file is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-escalation-test-'));
    temporaryRoots.push(root);

    await expect(EscalationPolicy.load({ projectRoot: root })).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_ESCALATION_POLICY'
    });
  });
});
