import type { JsonValue, NetworkPolicy, ToolPolicy } from '../config/schemas';

export interface FlowLogger {
  start(taskId: string): void;
  log(from: string, to: string, message: string): void;
  save(): Promise<string>;
}

export interface WorkerContext {
  clientId: string;
  automation: string;
  runId: string;
  clientRoot: string;
  clientDirectory: string;
  memoryDirectory: string;
  input?: JsonValue;
  toolPolicy: ToolPolicy;
  networkPolicy: NetworkPolicy;
  logger: FlowLogger;
}

export interface BasicWorker {
  readonly id: string;
  execute(context: WorkerContext): Promise<JsonValue>;
  commit?: undefined;
  rollback?: undefined;
  release?: undefined;
}

export interface TransactionalWorker {
  readonly id: string;
  execute(context: WorkerContext): Promise<JsonValue>;
  commit(context: WorkerContext, result: JsonValue): Promise<void>;
  rollback(context: WorkerContext): Promise<void>;
  release(context: WorkerContext): Promise<void> | void;
}

export type Worker = BasicWorker | TransactionalWorker;

export interface WorkerRegistration {
  readonly clientId: string;
  readonly automation: string;
  readonly worker: Worker;
}
