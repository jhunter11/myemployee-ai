import type { CreateClientRequest } from '../config/schemas';
import type { ClientRecord, ClientRepository, NewClientRecord } from '../db/client-repository';
import type { MarkdownGraph } from '../memory/markdown-graph';
import { AppError } from '../utils/errors';
import type { ClientScaffolder } from './scaffold';
import type { PolicyService } from '../config/policies';

export interface ClientRegistryStore {
  list(): Promise<ClientRecord[]>;
  findById(id: string): Promise<ClientRecord | undefined>;
  create(input: NewClientRecord): Promise<ClientRecord>;
  delete(id: string): Promise<boolean>;
}

export interface ClientService {
  list(): Promise<ClientRecord[]>;
  findById(id: string): Promise<ClientRecord | undefined>;
  create(input: CreateClientRequest): Promise<ClientRecord>;
}

export class DatabaseClientService implements ClientService {
  constructor(
    private readonly clients: ClientRepository,
    private readonly now: () => string
  ) {}

  list(): Promise<ClientRecord[]> {
    return this.clients.list();
  }

  findById(id: string): Promise<ClientRecord | undefined> {
    return this.clients.findById(id);
  }

  async create(input: CreateClientRequest): Promise<ClientRecord> {
    const existing = await this.clients.findById(input.id);
    if (existing !== undefined) {
      throw new AppError(409, 'CLIENT_EXISTS', `Client ${input.id} already exists`);
    }

    return this.clients.create({
      ...input,
      status: 'active',
      createdAt: this.now()
    });
  }
}

export interface LifecycleClientServiceOptions {
  registry: ClientRegistryStore;
  scaffolder: ClientScaffolder;
  policies: PolicyService;
  graph: MarkdownGraph;
  now: () => string;
}

export class LifecycleClientService implements ClientService {
  private readonly creationLocks = new Map<string, Promise<void>>();

  constructor(private readonly options: LifecycleClientServiceOptions) {}

  list(): Promise<ClientRecord[]> {
    return this.options.registry.list();
  }

  findById(id: string): Promise<ClientRecord | undefined> {
    return this.options.registry.findById(id);
  }

  async create(input: CreateClientRequest): Promise<ClientRecord> {
    const previous = this.creationLocks.get(input.id) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.creationLocks.set(input.id, tail);
    await previous;

    try {
      return await this.createUnlocked(input);
    } finally {
      release();
      if (this.creationLocks.get(input.id) === tail) {
        this.creationLocks.delete(input.id);
      }
    }
  }

  private async createUnlocked(input: CreateClientRequest): Promise<ClientRecord> {
    const existing = await this.options.registry.findById(input.id);
    if (existing !== undefined) {
      throw new AppError(409, 'CLIENT_EXISTS', `Client ${input.id} already exists`);
    }

    const toolPolicy = this.options.policies.resolveToolPolicy(input.profile);
    const networkPolicy = this.options.policies.resolveNetworkPolicy(input.id);
    const createdAt = this.options.now();
    const scaffold = await this.options.scaffolder.scaffold({
      client: input,
      createdAt,
      toolPolicy,
      networkPolicy
    });
    let stored = false;
    let graphAttempted = false;

    try {
      const client = await this.options.registry.create({
        ...input,
        status: 'active',
        createdAt
      });
      stored = true;
      graphAttempted = true;
      await this.options.graph.createClientNode({
        ...client,
        clientDirectory: scaffold.config.clientDirectory
      });
      await this.options.graph.rebuild();
      return client;
    } catch (error) {
      const cleanups: Array<Promise<unknown>> = [scaffold.rollback()];
      if (stored) cleanups.push(this.options.registry.delete(input.id));
      if (graphAttempted) cleanups.push(this.options.graph.removeClientNode(input.id));
      await Promise.allSettled(cleanups);
      throw error;
    }
  }
}
