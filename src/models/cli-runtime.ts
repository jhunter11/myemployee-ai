import { spawn } from 'node:child_process';

import { type ModelProviderId, type ProviderAvailability } from './contracts';
import { ProviderCredentialInspector } from '../secrets/provider-credentials';

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

export interface CliInvocation {
  input?: string;
  timeoutMs: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Runs a subprocess with a hard timeout and bounded output capture, feeding
 * `input` on stdin. Injected into the CLI-backed providers so unit tests drive a
 * fake runner and never spawn a real process.
 */
export type CliRunner = (
  command: string,
  args: string[],
  invocation: CliInvocation
) => Promise<CliResult>;

const MAX_OUTPUT_BYTES = 4_000_000;
const BASE_CLI_ENVIRONMENT_KEYS = [
  'HOME',
  'PATH',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS'
] as const;

/**
 * Builds the subprocess environment as an allow-list. Model CLIs must not
 * inherit unrelated database, provider API-key, tenant, or application
 * secrets merely because those values exist in the gateway environment.
 */
export function minimalCliEnvironment(
  source: NodeJS.ProcessEnv,
  additionalKeys: readonly string[] = []
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [...BASE_CLI_ENVIRONMENT_KEYS, ...additionalKeys]) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

export const defaultCliRunner: CliRunner = (command, args, invocation) =>
  new Promise<CliResult>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: invocation.cwd,
      env: invocation.env ?? minimalCliEnvironment(process.env),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, invocation.timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });

    child.stdin.end(invocation.input ?? '');
  });

/**
 * Availability probe closure for a subscription provider. Reuses the secrets
 * plane — credentials come ONLY from there (safety rule 5) — and treats a
 * secrets-plane `valid` state as available. Presence is not proof of live
 * validity (a token can be revoked server-side); a call-time auth failure then
 * degrades to the next provider. Never returns or logs any token bytes.
 */
export type CredentialProbe = () => Promise<ProviderAvailability>;

export function secretsPlaneProbe(
  providerId: ModelProviderId,
  inspectorFactory: () => ProviderCredentialInspector = () => new ProviderCredentialInspector()
): CredentialProbe {
  return async () => {
    try {
      const statuses = await inspectorFactory().statuses();
      const mine = statuses.find((status) => status.provider === providerId);
      return {
        provider: providerId,
        available: mine?.state === 'valid',
        detail: mine?.detail ?? 'no credential source'
      };
    } catch {
      return { provider: providerId, available: false, detail: 'credential probe failed' };
    }
  };
}
