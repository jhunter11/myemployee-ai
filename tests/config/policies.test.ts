import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PolicyService } from '../../src/config/policies';

const projectRoot = join(__dirname, '..', '..');

const validApproval = {
  profile: 'full_automation',
  approved: true,
  approver: 'agency-owner@example.com',
  timestamp: '2026-07-18T12:00:00.000Z'
} as const;

async function createPolicyRoot(approvalRecord = 'config/elevated-permissions.json') {
  const root = await mkdtemp(join(tmpdir(), 'jarvis-policy-test-'));
  await mkdir(join(root, 'config', 'tool-policies'), { recursive: true });
  await mkdir(join(root, 'config', 'network-policies'), { recursive: true });
  await writeFile(
    join(root, 'config', 'tool-policies', 'default.json'),
    JSON.stringify({
      profiles: {
        full_automation: {
          description: 'Elevated profile',
          tools_allow: ['exec'],
          tools_deny: [],
          requires_elevated_approval: true,
          approval_record: approvalRecord
        }
      }
    })
  );
  await writeFile(
    join(root, 'config', 'network-policies', 'default.json'),
    JSON.stringify({ default: { mode: 'none' } })
  );
  return root;
}

describe('PolicyService', () => {
  const temporaryRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it('resolves the blueprint data-processing tool policy', async () => {
    const policies = await PolicyService.load({ projectRoot });

    expect(policies.resolveToolPolicy('data_processing')).toMatchObject({
      tools_allow: ['read', 'write', 'exec'],
      tools_deny: ['process'],
      exec_scope: 'python3,node',
      requires_elevated_approval: false
    });
  });

  it('resolves fixture-only offline compute without process or write authority', async () => {
    const policies = await PolicyService.load({ projectRoot });

    expect(policies.resolveToolPolicy('offline_compute')).toEqual({
      description:
        'Pinned fixture-only compute. The host runner supplies an immutable source copy and OS-enforced no-network sandbox.',
      tools_allow: ['read', 'exec'],
      tools_deny: ['write', 'process', 'apply_patch'],
      exec_scope: '/usr/bin/python3:pmqs-fixture-backtest-v1',
      requires_elevated_approval: false
    });
  });

  it('uses the default deny-network policy for an unassigned client', async () => {
    const policies = await PolicyService.load({ projectRoot });

    expect(policies.resolveNetworkPolicy('acme_corp')).toEqual({
      mode: 'none',
      description:
        'Default policy: no network access for new client sandboxes until explicitly granted.'
    });
  });

  it('uses a client-specific network allowlist when configured', async () => {
    const policies = await PolicyService.load({ projectRoot });
    const policy = policies.resolveNetworkPolicy('client_a');

    expect(policy.mode).toBe('allowlist');
    if (policy.mode !== 'allowlist') throw new Error('Expected allowlist policy');
    expect(policy.deny_all_other).toBe(true);
    expect(policy.allowed_hosts).toContain('smtp.gmail.com:465');
    expect(policy.allowed_hosts).toContain('sheets.googleapis.com:443');
  });

  it('rejects full automation while its approval record is absent', async () => {
    const policies = await PolicyService.load({ projectRoot });

    expect(() => policies.resolveToolPolicy('full_automation')).toThrowError(
      expect.objectContaining({ statusCode: 403, code: 'PROFILE_APPROVAL_REQUIRED' })
    );
  });

  it('accepts a strict, matching approval record stored as a regular JSON file', async () => {
    const root = await createPolicyRoot();
    temporaryRoots.push(root);
    await writeFile(
      join(root, 'config', 'elevated-permissions.json'),
      JSON.stringify(validApproval)
    );

    const policies = await PolicyService.load({ projectRoot: root });

    expect(policies.resolveToolPolicy('full_automation')).toMatchObject({
      requires_elevated_approval: true,
      approval_record: 'config/elevated-permissions.json'
    });
  });

  it('keeps a missing approval record as an authorization denial', async () => {
    const root = await createPolicyRoot();
    temporaryRoots.push(root);

    const policies = await PolicyService.load({ projectRoot: root });

    expect(() => policies.resolveToolPolicy('full_automation')).toThrowError(
      expect.objectContaining({ statusCode: 403, code: 'PROFILE_APPROVAL_REQUIRED' })
    );
  });

  it.each([
    [
      'a directory',
      async (root: string) => mkdir(join(root, 'config', 'elevated-permissions.json'))
    ],
    [
      'a symbolic link',
      async (root: string) => {
        const target = join(root, 'config', 'actual-approval.json');
        await writeFile(target, JSON.stringify(validApproval));
        await symlink(target, join(root, 'config', 'elevated-permissions.json'));
      }
    ]
  ])('rejects an approval record represented by %s', async (_description, arrange) => {
    const root = await createPolicyRoot();
    temporaryRoots.push(root);
    await arrange(root);

    await expect(PolicyService.load({ projectRoot: root })).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_POLICY_CONFIG'
    });
  });

  it.each([
    ['a mismatched profile', { ...validApproval, profile: 'email_only' }],
    ['an unapproved decision', { ...validApproval, approved: false }],
    ['a blank approver', { ...validApproval, approver: '  ' }],
    ['an invalid timestamp', { ...validApproval, timestamp: 'yesterday' }],
    ['an unknown field', { ...validApproval, ticket: 'SEC-42' }]
  ])('rejects an approval record with %s', async (_description, record) => {
    const root = await createPolicyRoot();
    temporaryRoots.push(root);
    await writeFile(join(root, 'config', 'elevated-permissions.json'), JSON.stringify(record));

    await expect(PolicyService.load({ projectRoot: root })).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_POLICY_CONFIG'
    });
  });

  it.each(['../outside-approval.json', '/tmp/outside-approval.json'])(
    'rejects an approval path that traverses or points outside the project root: %s',
    async (approvalRecord) => {
      const root = await createPolicyRoot(approvalRecord);
      temporaryRoots.push(root);

      await expect(PolicyService.load({ projectRoot: root })).rejects.toMatchObject({
        statusCode: 500,
        code: 'INVALID_POLICY_CONFIG'
      });
    }
  );

  it('rejects a regular file reached through a parent symlink outside the project root', async () => {
    const root = await createPolicyRoot('config/linked/approval.json');
    const outsideRoot = await mkdtemp(join(tmpdir(), 'jarvis-policy-outside-'));
    temporaryRoots.push(root, outsideRoot);
    await writeFile(join(outsideRoot, 'approval.json'), JSON.stringify(validApproval));
    await symlink(outsideRoot, join(root, 'config', 'linked'));

    await expect(PolicyService.load({ projectRoot: root })).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_POLICY_CONFIG'
    });
  });

  it('rejects malformed policy files with a safe configuration error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'jarvis-policy-test-'));
    temporaryRoots.push(root);
    await mkdir(join(root, 'config', 'tool-policies'), { recursive: true });
    await mkdir(join(root, 'config', 'network-policies'), { recursive: true });
    await writeFile(
      join(root, 'config', 'tool-policies', 'default.json'),
      JSON.stringify({ profiles: { data_processing: { tools_allow: 'not-an-array' } } })
    );
    await writeFile(
      join(root, 'config', 'network-policies', 'default.json'),
      JSON.stringify({ default: { mode: 'none' } })
    );

    await expect(PolicyService.load({ projectRoot: root })).rejects.toMatchObject({
      statusCode: 500,
      code: 'INVALID_POLICY_CONFIG'
    });
  });
});
