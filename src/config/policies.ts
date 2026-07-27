import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { z } from 'zod';

import {
  ClientProfileSchema,
  ElevatedApprovalRecordSchema,
  NetworkPolicySchema,
  ToolPolicyFileSchema,
  type ClientProfile,
  type NetworkPolicy,
  type ToolPolicy
} from './schemas';
import { AppError } from '../utils/errors';

const NetworkPolicyFileSchema = z.record(z.string(), NetworkPolicySchema);

export interface PolicyServiceOptions {
  projectRoot: string;
}

function parseJson(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot));
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function assertRelativeApprovalPath(approvalRecord: string): void {
  const hasTraversalSegment = approvalRecord.split(/[\\/]+/u).includes('..');
  const hasWindowsRoot = /^[a-z]:[\\/]/iu.test(approvalRecord) || approvalRecord.startsWith('\\\\');
  if (isAbsolute(approvalRecord) || hasWindowsRoot || hasTraversalSegment) {
    throw new Error('Approval record must be a non-traversing relative path');
  }
}

async function hasValidApprovalRecord(
  projectRoot: string,
  approvalRecord: string,
  profile: ClientProfile
): Promise<boolean> {
  assertRelativeApprovalPath(approvalRecord);
  const resolvedRoot = resolve(projectRoot);
  const approvalPath = resolve(resolvedRoot, approvalRecord);
  if (!isWithin(resolvedRoot, approvalPath)) {
    throw new Error('Approval record resolves outside the project root');
  }

  let metadata;
  try {
    metadata = await lstat(approvalPath);
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw error;
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error('Approval record must be a non-symlink regular file');
  }

  const [canonicalRoot, canonicalApprovalPath] = await Promise.all([
    realpath(resolvedRoot),
    realpath(approvalPath)
  ]);
  if (!isWithin(canonicalRoot, canonicalApprovalPath)) {
    throw new Error('Approval record resolves outside the canonical project root');
  }

  const parsed = ElevatedApprovalRecordSchema.parse(
    parseJson(await readFile(canonicalApprovalPath, 'utf8'))
  );
  if (parsed.profile !== profile) {
    throw new Error('Approval record profile does not match the elevated profile');
  }
  return true;
}

export class PolicyService {
  private constructor(
    private readonly toolPolicies: Map<ClientProfile, ToolPolicy>,
    private readonly networkPolicies: Map<string, NetworkPolicy>,
    private readonly approvedProfiles: Set<ClientProfile>
  ) {}

  static async load(options: PolicyServiceOptions): Promise<PolicyService> {
    try {
      const [toolText, networkText] = await Promise.all([
        readFile(join(options.projectRoot, 'config', 'tool-policies', 'default.json'), 'utf8'),
        readFile(join(options.projectRoot, 'config', 'network-policies', 'default.json'), 'utf8')
      ]);
      const toolFile = ToolPolicyFileSchema.parse(parseJson(toolText));
      const networkRaw = parseJson(networkText);
      if (networkRaw === null || typeof networkRaw !== 'object' || Array.isArray(networkRaw)) {
        throw new Error('Network policy file must be an object');
      }
      const { _comment: _ignored, ...networkEntries } = networkRaw as Record<string, unknown>;
      void _ignored;
      const parsedNetworks = NetworkPolicyFileSchema.parse(networkEntries);
      if (parsedNetworks.default === undefined) {
        throw new Error('Network policy file requires a default policy');
      }

      const toolPolicies = new Map<ClientProfile, ToolPolicy>();
      const approvedProfiles = new Set<ClientProfile>();
      for (const [profileName, policy] of Object.entries(toolFile.profiles)) {
        const profile = ClientProfileSchema.parse(profileName);
        toolPolicies.set(profile, policy);
        if (policy.requires_elevated_approval && policy.approval_record !== undefined) {
          if (await hasValidApprovalRecord(options.projectRoot, policy.approval_record, profile)) {
            approvedProfiles.add(profile);
          }
        }
      }

      return new PolicyService(
        toolPolicies,
        new Map(Object.entries(parsedNetworks)),
        approvedProfiles
      );
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(500, 'INVALID_POLICY_CONFIG', 'Policy configuration is invalid');
    }
  }

  resolveToolPolicy(profile: ClientProfile): ToolPolicy {
    const policy = this.toolPolicies.get(profile);
    if (policy === undefined) {
      throw new AppError(500, 'TOOL_POLICY_NOT_FOUND', `No tool policy exists for ${profile}`);
    }
    if (policy.requires_elevated_approval && !this.approvedProfiles.has(profile)) {
      throw new AppError(
        403,
        'PROFILE_APPROVAL_REQUIRED',
        `Profile ${profile} requires an approval record`
      );
    }
    return {
      ...policy,
      tools_allow: [...policy.tools_allow],
      tools_deny: [...policy.tools_deny]
    };
  }

  resolveNetworkPolicy(clientId: string): NetworkPolicy {
    const policy = this.networkPolicies.get(clientId) ?? this.networkPolicies.get('default');
    if (policy === undefined) {
      throw new AppError(500, 'NETWORK_POLICY_NOT_FOUND', 'Default network policy is missing');
    }
    return policy.mode === 'allowlist'
      ? { ...policy, allowed_hosts: [...policy.allowed_hosts] }
      : { ...policy };
  }
}
