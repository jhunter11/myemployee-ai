import process from 'node:process';

import { ModelRouteInputSchema, type ModelRouteInput } from '../economics/contracts';

/** Structured, secret-free CLI failure. Never carries prompt/response bytes. */
export class ModelCliError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'ModelCliError';
  }
}

export interface ModelCliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export const DEFAULT_MODEL_CLI_IO: ModelCliIo = {
  stdout: (message) => process.stdout.write(`${message}\n`),
  stderr: (message) => process.stderr.write(`${message}\n`)
};

export function parseFlags(
  argv: readonly string[],
  spec: { boolean?: readonly string[]; value?: readonly string[] }
): { positional: string[]; booleans: Set<string>; values: Map<string, string> } {
  const booleanFlags = new Set(spec.boolean ?? []);
  const valueFlags = new Set(spec.value ?? []);
  const positional: string[] = [];
  const booleans = new Set<string>();
  const values = new Map<string, string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) continue;
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    if (booleanFlags.has(argument)) {
      booleans.add(argument);
      continue;
    }
    if (!valueFlags.has(argument)) {
      throw new ModelCliError(
        'UNSUPPORTED_ARGUMENT',
        `Unsupported argument: ${sanitizeFlag(argument)}`
      );
    }
    if (values.has(argument)) {
      throw new ModelCliError('DUPLICATE_ARGUMENT', `Duplicate argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new ModelCliError('MISSING_VALUE', `Argument ${argument} requires a direct value`);
    }
    index += 1;
    values.set(argument, value);
  }

  return { positional, booleans, values };
}

function sanitizeFlag(argument: string): string {
  const trimmed = argument.slice(0, 40);
  return /^--[a-z-]+$/u.test(trimmed) ? trimmed : 'non-flag-token';
}

export function splitList(value: string | undefined): string[] {
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Named route presets so an operator never has to hand-author the full router
 * input. Each resolves deterministically to a single logical tier:
 * `local` -> tier 1 (Ollama), `economy` -> tier 2, `frontier` -> tier 3.
 */
export const ROUTE_PRESETS = ['local', 'economy', 'frontier'] as const;
export type RoutePreset = (typeof ROUTE_PRESETS)[number];

export function isRoutePreset(value: string): value is RoutePreset {
  return (ROUTE_PRESETS as readonly string[]).includes(value);
}

export function routeInputForPreset(
  preset: RoutePreset,
  operation = 'operator_run'
): ModelRouteInput {
  const base = {
    operation,
    risk: 'low' as const,
    sensitivity: 'internal' as const,
    assurance: 'standard' as const,
    priorValidationFailures: 0 as const,
    networkMode: 'allowlist' as const
  };
  if (preset === 'local') {
    return ModelRouteInputSchema.parse({ ...base, workType: 'summarization' });
  }
  if (preset === 'economy') {
    return ModelRouteInputSchema.parse({ ...base, workType: 'synthesis' });
  }
  return ModelRouteInputSchema.parse({ ...base, workType: 'synthesis', risk: 'high' });
}
