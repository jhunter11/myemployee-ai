/**
 * The deterministic memory ledger (Report 2).
 *
 * Layered deliberately: the pure core (records, lifecycle, authority, canonical
 * form, conflict) knows nothing about storage; the reducer knows nothing about
 * SQLite; the repository decides nothing. Anything that wants a different storage
 * engine replaces the last layer only.
 */
export * from './record-contracts';
export * from './lifecycle';
export * from './authority';
export * from './canonical';
export * from './conflict';
export * from './commands';
export * from './reducer';
export * from './invalidation';
export {
  LedgerRepository,
  LedgerStaleBaseError,
  LedgerCommandRejectedError,
  LedgerSleeveBindingError,
  type LedgerSubmitResult,
  type LedgerReplayResult
} from './ledger-repository';
export { LedgerMemorySystem, type LedgerMemorySystemOptions } from './ledger-memory-system';
