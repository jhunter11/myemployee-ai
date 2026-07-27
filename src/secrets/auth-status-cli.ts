import process from 'node:process';

import {
  ProviderCredentialInspector,
  type CredentialState,
  type CredentialStatus
} from './provider-credentials';

export interface AuthStatusCliOptions {
  inspector?: { statuses(): Promise<CredentialStatus[]> };
  write?: (message: string) => void;
}

/**
 * `jarvis auth status` — reports, per provider, whether a valid credential is
 * present. Output is bounded, structured, and free of secret material: only the
 * provider, state, non-secret source label, and a redacted detail are printed.
 */
export async function runAuthStatusCli(
  options: AuthStatusCliOptions = {}
): Promise<CredentialStatus[]> {
  const inspector = options.inspector ?? new ProviderCredentialInspector();
  const write = options.write ?? console.log;
  const statuses = await inspector.statuses();

  for (const status of statuses) {
    write(
      JSON.stringify({
        event: 'auth_status',
        provider: status.provider,
        state: status.state,
        source: status.source,
        detail: status.detail
      })
    );
  }

  const byState = statuses.reduce<Record<CredentialState, number>>(
    (accumulator, status) => {
      accumulator[status.state] += 1;
      return accumulator;
    },
    { valid: 0, expired: 0, missing: 0, malformed: 0 }
  );

  write(
    JSON.stringify({
      event: 'auth_status_summary',
      total: statuses.length,
      valid: byState.valid,
      byState
    })
  );

  return statuses;
}

if (require.main === module) {
  void runAuthStatusCli().then(
    (statuses) => {
      // Exit non-zero when any credentialed provider lacks a usable credential,
      // so operators and scripts can gate on `jarvis auth status`.
      const blocking = statuses.filter(
        (status) => status.provider !== 'ollama' && status.state !== 'valid'
      );
      process.exitCode = blocking.length === 0 ? 0 : 1;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    }
  );
}
