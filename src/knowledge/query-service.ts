import { z } from 'zod';

import { AppError } from '../utils/errors';
import {
  KnowledgeContentHitSchema,
  KnowledgeAdapterIsolationSchema,
  KnowledgeMetadataHitSchema,
  KnowledgePrincipalSchema,
  KnowledgeQueryInputSchema,
  type KnowledgeContentHit,
  type KnowledgeMetadataHit,
  type KnowledgePrincipal,
  type KnowledgeProjection,
  type KnowledgeQueryInput,
  type KnowledgeQueryResult,
  type ScopedKnowledgeAdapterResolver
} from './contracts';
import type { KnowledgeScopeRepository } from './scope-repository';

function forbidden(): AppError {
  return new AppError(403, 'KNOWLEDGE_SCOPE_FORBIDDEN', 'Knowledge scope selection is forbidden');
}

function adapterInvalid(error?: unknown): AppError {
  return new AppError(
    502,
    'KNOWLEDGE_ADAPTER_INVALID',
    'Knowledge adapter returned an invalid redacted record',
    error instanceof z.ZodError ? error.issues : undefined
  );
}

function safeObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw adapterInvalid();
  }
  return value as Record<string, unknown>;
}

function redactHit(
  rawHit: unknown,
  projection: KnowledgeProjection
): KnowledgeMetadataHit | KnowledgeContentHit {
  const hit = safeObject(rawHit);
  const metadata = {
    documentId: hit.documentId,
    title: hit.title,
    kind: hit.kind,
    updatedAt: hit.updatedAt,
    score: hit.score,
    tags: hit.tags ?? []
  };
  try {
    return projection === 'metadata'
      ? KnowledgeMetadataHitSchema.parse(metadata)
      : KnowledgeContentHitSchema.parse({ ...metadata, excerpt: hit.excerpt });
  } catch (error) {
    throw adapterInvalid(error);
  }
}

export class KnowledgeQueryService {
  constructor(
    private readonly scopes: KnowledgeScopeRepository,
    private readonly adapters: ScopedKnowledgeAdapterResolver,
    rawPrincipal: KnowledgePrincipal
  ) {
    this.principal = KnowledgePrincipalSchema.parse(rawPrincipal);
  }

  private readonly principal: KnowledgePrincipal;

  async query(rawInput: KnowledgeQueryInput): Promise<KnowledgeQueryResult> {
    const input = KnowledgeQueryInputSchema.parse(rawInput);

    // This deny happens before target lookup or adapter resolution so a client
    // cannot use the service as an existence oracle for any other scope.
    if (this.principal.kind === 'client' && input.scopeId !== this.principal.scopeId) {
      throw forbidden();
    }

    const principalScope = await this.scopes.findById(this.principal.scopeId);
    if (principalScope === undefined || principalScope.kind !== this.principal.kind) {
      throw new AppError(
        403,
        'KNOWLEDGE_PRINCIPAL_INVALID',
        'Knowledge principal does not match a registered scope'
      );
    }

    const targetScope = await this.scopes.findById(input.scopeId);
    if (targetScope === undefined) {
      throw new AppError(404, 'KNOWLEDGE_SCOPE_NOT_FOUND', 'Knowledge scope was not found');
    }

    const exactScope = principalScope.id === targetScope.id;
    if (!exactScope && !(await this.scopes.isAncestor(principalScope.id, targetScope.id))) {
      throw forbidden();
    }

    const projection: KnowledgeProjection =
      exactScope || input.projection === 'metadata' ? input.projection : 'metadata';
    const adapter = this.adapters.resolve(targetScope.graphPartition);
    if (adapter === undefined) {
      throw new AppError(
        503,
        'KNOWLEDGE_ADAPTER_UNAVAILABLE',
        'No knowledge adapter is registered for this scope partition'
      );
    }
    const isolation = KnowledgeAdapterIsolationSchema.safeParse(adapter.isolation);
    if (
      !isolation.success ||
      isolation.data.graphPartition !== targetScope.graphPartition ||
      (isolation.data.queryLogging.mode === 'scope-protected' &&
        isolation.data.queryLogging.logPartition !== targetScope.graphPartition)
    ) {
      throw new AppError(
        503,
        'KNOWLEDGE_ADAPTER_ISOLATION_INVALID',
        'Knowledge adapter isolation does not match the registered scope partition'
      );
    }

    let rawItems: readonly unknown[];
    try {
      rawItems = await adapter.query({
        graphPartition: targetScope.graphPartition,
        text: input.text,
        projection,
        limit: input.limit
      });
    } catch {
      throw new AppError(502, 'KNOWLEDGE_QUERY_FAILED', 'Scoped knowledge query failed');
    }
    if (!Array.isArray(rawItems)) throw adapterInvalid();

    return {
      scopeId: targetScope.id,
      projection,
      redacted: !exactScope,
      items: rawItems.slice(0, input.limit).map((item) => redactHit(item, projection))
    };
  }
}
