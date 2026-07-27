import { AutomationIdSchema, ClientIdSchema } from '../config/schemas';
import { AppError } from '../utils/errors';
import type { Worker, WorkerRegistration } from './contracts';

function assertValidRegistration(registration: WorkerRegistration): void {
  const validClient = ClientIdSchema.safeParse(registration.clientId).success;
  const validAutomation = AutomationIdSchema.safeParse(registration.automation).success;
  const hooks = [
    registration.worker.commit,
    registration.worker.rollback,
    registration.worker.release
  ];
  const hasAnyTransactionHook = hooks.some((hook) => hook !== undefined);
  const hasCompleteTransactionHooks = hooks.every((hook) => typeof hook === 'function');
  const validWorker =
    typeof registration.worker.id === 'string' &&
    registration.worker.id.trim().length > 0 &&
    typeof registration.worker.execute === 'function' &&
    (!hasAnyTransactionHook || hasCompleteTransactionHooks);

  if (!validClient || !validAutomation || !validWorker) {
    throw new AppError(500, 'INVALID_WORKER_REGISTRATION', 'Static worker registration is invalid');
  }
}

export class WorkerRegistry {
  private readonly workers = new Map<string, Map<string, Worker>>();

  constructor(registrations: readonly WorkerRegistration[] = []) {
    for (const registration of registrations) {
      this.register(registration);
    }
  }

  register(registration: WorkerRegistration): void {
    assertValidRegistration(registration);

    const clientWorkers = this.workers.get(registration.clientId) ?? new Map<string, Worker>();
    if (clientWorkers.has(registration.automation)) {
      throw new AppError(
        409,
        'WORKER_ALREADY_REGISTERED',
        `Automation ${registration.automation} is already registered for client ${registration.clientId}`
      );
    }

    clientWorkers.set(registration.automation, registration.worker);
    this.workers.set(registration.clientId, clientWorkers);
  }

  resolve(clientId: string, automation: string): Worker {
    const worker = this.workers.get(clientId)?.get(automation);
    if (worker === undefined) {
      throw new AppError(
        404,
        'AUTOMATION_NOT_FOUND',
        `Automation ${automation} is not registered for client ${clientId}`
      );
    }
    return worker;
  }

  has(clientId: string, automation: string): boolean {
    const parsedClientId = ClientIdSchema.safeParse(clientId);
    const parsedAutomation = AutomationIdSchema.safeParse(automation);
    if (!parsedClientId.success || !parsedAutomation.success) return false;
    return this.workers.get(parsedClientId.data)?.has(parsedAutomation.data) ?? false;
  }
}
