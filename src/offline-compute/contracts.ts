import { createHash } from 'node:crypto';

import { z } from 'zod';

import { AppError } from '../utils/errors';

export const PMQS_REPOSITORY = 'jhunter11/pmqs' as const;
export const PMQS_COMMIT = '6fbd6d4fe0b9b17c18d5560fb1507a6cd66ac6d4' as const;
export const PMQS_TREE = '8cf4d1fd58e29c44fc537d19739c1135ed76987e' as const;
export const PMQS_COMMAND_ID = 'pmqs-fixture-backtest-v1' as const;
export const PMQS_SCRIPT_PATH = 'examples/run_fixture_backtest.py' as const;

const sha256Pattern = /^[a-f0-9]{64}$/u;
const sourceDirectoryPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function isSafeSourcePath(path: string): boolean {
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  const segments = path.split('/');
  return (
    segments.length <= 8 &&
    segments.every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..' && segment.length <= 128
    )
  );
}

export const SourceFileRecordSchema = z.strictObject({
  path: z.string().max(512).refine(isSafeSourcePath, 'Source path must be safe and relative'),
  bytes: z.number().int().nonnegative().max(1_000_000),
  sha256: z.string().regex(sha256Pattern)
});

export type SourceFileRecord = z.infer<typeof SourceFileRecordSchema>;

function comparePath(left: SourceFileRecord, right: SourceFileRecord): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

export function digestSourceFileRecords(files: readonly SourceFileRecord[]): string {
  const canonical = [...files]
    .sort(comparePath)
    .map((file) => `${JSON.stringify([file.path, file.bytes, file.sha256])}\n`)
    .join('');
  return createHash('sha256').update(canonical).digest('hex');
}

const OfflineComputeProfileSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.literal('offline_compute'),
    commandId: z.literal(PMQS_COMMAND_ID),
    network: z.literal('none'),
    timeoutMs: z.number().int().min(25).max(30_000),
    maxOutputBytes: z.number().int().min(128).max(65_536),
    source: z.strictObject({
      repository: z.literal(PMQS_REPOSITORY),
      commit: z.literal(PMQS_COMMIT),
      tree: z.literal(PMQS_TREE),
      directory: z.string().regex(sourceDirectoryPattern),
      digest: z.string().regex(sha256Pattern),
      files: z.array(SourceFileRecordSchema).min(1).max(256)
    })
  })
  .superRefine((profile, context) => {
    const sortedFiles = [...profile.source.files].sort(comparePath);
    if (sortedFiles.some((file, index) => file.path !== profile.source.files[index]?.path)) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'files'],
        message: 'Source files must be sorted by path'
      });
    }
    if (new Set(sortedFiles.map((file) => file.path)).size !== sortedFiles.length) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'files'],
        message: 'Source file paths must be unique'
      });
    }
    if (!sortedFiles.some((file) => file.path === PMQS_SCRIPT_PATH)) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'files'],
        message: 'Pinned fixture entrypoint is required'
      });
    }
    if (digestSourceFileRecords(sortedFiles) !== profile.source.digest) {
      context.addIssue({
        code: 'custom',
        path: ['source', 'digest'],
        message: 'Source digest does not match the immutable file manifest'
      });
    }
  });

export type OfflineComputeProfile = z.infer<typeof OfflineComputeProfileSchema>;

export function parseOfflineComputeProfile(value: unknown): OfflineComputeProfile {
  const result = OfflineComputeProfileSchema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      500,
      'INVALID_OFFLINE_COMPUTE_PROFILE',
      'Offline compute profile is invalid'
    );
  }
  return result.data;
}

export type OfflineComputeStatus = 'succeeded' | 'failed' | 'timeout' | 'output_limit';
export type OfflineComputeReason =
  'COMMAND_FAILED' | 'NETWORK_GUARD_FAILED' | 'OUTPUT_LIMIT' | 'TIMEOUT' | 'VERDICT_INVALID' | null;

export interface StreamDigest {
  bytes: number;
  sha256: string;
}

export interface OfflineComputeResult {
  profile: 'offline_compute';
  commandId: typeof PMQS_COMMAND_ID;
  source: {
    repository: typeof PMQS_REPOSITORY;
    commit: typeof PMQS_COMMIT;
    tree: typeof PMQS_TREE;
    digest: string;
  };
  status: OfflineComputeStatus;
  reason: OfflineComputeReason;
  verdict: 'PASS' | 'FAIL' | null;
  stdout: StreamDigest;
  stderr: StreamDigest;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}
