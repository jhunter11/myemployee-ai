import type SQLite from 'better-sqlite3';

import type { BoundAgentAccess } from '../../agents/access-control-repository';
import { LedgerMemorySystem } from '../ledger/ledger-memory-system';
import { MemorySystemIdSchema, type MemorySystem, type MemorySystemId } from './contracts';
import { FlatLexicalMemorySystem } from './flat-lexical-system';
import { TemporalHybridMemorySystem } from './temporal-hybrid-system';
import { TypedHybridMemorySystem } from './typed-hybrid-system';
import { UntypedFlatMemorySystem } from './untyped-flat-system';

export interface CreateMemorySystemOptions {
  sqlite: SQLite.Database;
  access: BoundAgentAccess;
  /**
   * Which backend to bind. Omitted, it falls back to `JARVIS_MEMORY_BACKEND` and
   * then to the flat substrate, which stays authoritative.
   */
  backend?: MemorySystemId;
  /** Environment to resolve the fallback from. Injected so tests never read ambient state. */
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Binds one interchangeable memory backend for one authorized agent principal.
 * The default is the flat substrate: swapping backends is an explicit, additive
 * opt-in and changes no behavior of the flat retrieval path. Mirrors
 * `createProviderCatalog` in the model stack.
 */
export function createMemorySystem(options: CreateMemorySystemOptions): MemorySystem {
  const backend = options.backend ?? resolveMemoryBackendFromEnv(options.env ?? process.env);
  switch (backend) {
    case 'flat_untyped':
      return new UntypedFlatMemorySystem({ sqlite: options.sqlite, access: options.access });
    case 'flat':
      return new FlatLexicalMemorySystem({ sqlite: options.sqlite, access: options.access });
    case 'typed_hybrid':
      return new TypedHybridMemorySystem({ sqlite: options.sqlite, access: options.access });
    case 'typed_temporal':
      return new TemporalHybridMemorySystem({ sqlite: options.sqlite, access: options.access });
    case 'ledger':
      return new LedgerMemorySystem({ sqlite: options.sqlite, access: options.access });
    default: {
      const exhaustive: never = backend;
      throw new Error(`Unknown memory backend: ${String(exhaustive)}`);
    }
  }
}

/**
 * Resolves the backend selection from an environment map. Absent or unrecognized
 * values fall back to `flat`, so the safe default is never overridden by accident.
 *
 * `flat_untyped` is refused here even though it is a valid backend id. It is the
 * experimental control and returns superseded and expired facts by design, so
 * reaching it must be a deliberate act in code — as the bench and the demo do by
 * passing `backend` explicitly — and never something an ambient environment
 * variable can switch on underneath a running agency.
 */
export function resolveMemoryBackendFromEnv(
  env: Readonly<Record<string, string | undefined>>
): MemorySystemId {
  const parsed = MemorySystemIdSchema.safeParse(env.JARVIS_MEMORY_BACKEND);
  if (!parsed.success || parsed.data === 'flat_untyped') return 'flat';
  return parsed.data;
}
