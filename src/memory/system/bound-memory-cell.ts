import { z } from 'zod';

import {
  AccessAgentIdSchema,
  AuthorizeMemoryAccessInputSchema,
  AuthorizeMemoryRetrievalInputSchema,
  ControlScopeIdSchema,
  MemorySleeveIdSchema,
  type AccessSensitivity,
  type AuthorizeMemoryAccessInput,
  type AuthorizedMemoryAccess
} from '../../agents/access-control-contracts';
import type { BoundAgentAccess } from '../../agents/access-control-repository';
import {
  ScopedContextCompilerInputSchema,
  type ScopedContextCompilation
} from '../../knowledge/context-compiler';
import {
  LexicalRetrievalQuerySchema,
  MemoryFragmentInputSchema,
  type LexicalRetrievalResult,
  type MemoryFragmentRecord
} from '../../knowledge/retrieval-contracts';
import { AppError } from '../../utils/errors';
import {
  ConsolidationCandidateInputSchema,
  ConsolidationCandidateQuerySchema,
  ProcedureCandidateInputSchema,
  ProcedureCandidateQuerySchema,
  WorkingMemoryEntryInputSchema,
  WorkingMemoryReadQuerySchema,
  type ConsolidationProposalStore,
  type MemorySystem,
  type MemorySystemCapabilities,
  type MemorySystemId,
  type ProceduralPromotionStore,
  type WorkingMemoryStore
} from './contracts';
import { storeClassForKind } from './store-classes';

const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ProposeMemoryAuthorizationSchema = AuthorizeMemoryAccessInputSchema.safeExtend({
  permission: z.literal('propose')
});

export const BoundMemoryCellTierSchema = z.enum(['full', 'run_bounded']);

export const BoundMemoryCellBindingSchema = z
  .strictObject({
    agentId: AccessAgentIdSchema,
    ownerScopeId: ControlScopeIdSchema,
    sleeveId: MemorySleeveIdSchema,
    runId: z.string().regex(runIdPattern),
    tier: BoundMemoryCellTierSchema,
    readAuthorization: AuthorizeMemoryRetrievalInputSchema,
    proposeAuthorization: ProposeMemoryAuthorizationSchema
  })
  .superRefine((binding, context) => {
    for (const [field, authorization] of [
      ['readAuthorization', binding.readAuthorization],
      ['proposeAuthorization', binding.proposeAuthorization]
    ] as const) {
      if (authorization.sleeveId !== binding.sleeveId) {
        context.addIssue({
          code: 'custom',
          path: [field, 'sleeveId'],
          message: 'Authorization sleeve must match the bound memory cell'
        });
      }
    }
    if (
      binding.readAuthorization.expectedSleeveVersion !==
        binding.proposeAuthorization.expectedSleeveVersion ||
      binding.readAuthorization.expectedOwnerScopeVersion !==
        binding.proposeAuthorization.expectedOwnerScopeVersion
    ) {
      context.addIssue({
        code: 'custom',
        path: ['proposeAuthorization'],
        message: 'Read and propose authority must bind the same scope and sleeve versions'
      });
    }
  });

export type BoundMemoryCellTier = z.infer<typeof BoundMemoryCellTierSchema>;
export type BoundMemoryCellBinding = z.infer<typeof BoundMemoryCellBindingSchema>;

export interface BoundMemoryCellOptions {
  readonly system: MemorySystem;
  readonly access: BoundAgentAccess;
  readonly binding: BoundMemoryCellBinding;
}

export class BoundMemoryCellPolicyError extends AppError {
  constructor(operation: string) {
    super(403, 'MEMORY_CELL_POLICY_DENIED', `The bound memory cell does not permit '${operation}'`);
    this.name = 'BoundMemoryCellPolicyError';
  }
}

export class BoundMemoryCellBindingError extends AppError {
  constructor() {
    super(403, 'MEMORY_CELL_BINDING_DENIED', 'Memory cell authorization binding is not valid');
    this.name = 'BoundMemoryCellBindingError';
  }
}

const BoundFragmentInputSchema = z.strictObject({
  ...MemoryFragmentInputSchema.shape,
  ownerScopeId: z.unknown().optional(),
  sleeveId: z.unknown().optional()
});

const BoundRetrievalQuerySchema = z.strictObject({
  ...LexicalRetrievalQuerySchema.shape,
  authorization: z.unknown().optional()
});

const BoundContextInputSchema = z.strictObject({
  ...ScopedContextCompilerInputSchema.shape,
  ownerScopeId: z.unknown().optional(),
  sleeveId: z.unknown().optional(),
  evaluatedAt: z.unknown().optional()
});

const BoundWorkingEntrySchema = z.strictObject({
  ...WorkingMemoryEntryInputSchema.shape,
  ownerScopeId: z.unknown().optional(),
  sleeveId: z.unknown().optional(),
  runId: z.unknown().optional()
});

const BoundWorkingReadSchema = z.strictObject({
  ...WorkingMemoryReadQuerySchema.shape,
  ownerScopeId: z.unknown().optional(),
  sleeveId: z.unknown().optional(),
  runId: z.unknown().optional(),
  evaluatedAt: z.unknown().optional()
});

const BoundConsolidationInputSchema = z.strictObject({
  ...ConsolidationCandidateInputSchema.shape,
  ownerScopeId: z.unknown().optional(),
  sleeveId: z.unknown().optional(),
  proposedBy: z.unknown().optional()
});

const BoundConsolidationQuerySchema = z.strictObject({
  ...ConsolidationCandidateQuerySchema.shape,
  ownerScopeId: z.unknown().optional(),
  sleeveId: z.unknown().optional(),
  evaluatedAt: z.unknown().optional()
});

const BoundProcedureInputSchema = z.strictObject({
  ...ProcedureCandidateInputSchema.shape,
  ownerScopeId: z.unknown().optional(),
  sleeveId: z.unknown().optional(),
  proposedBy: z.unknown().optional()
});

const BoundProcedureQuerySchema = z.strictObject({
  ...ProcedureCandidateQuerySchema.shape,
  ownerScopeId: z.unknown().optional(),
  sleeveId: z.unknown().optional(),
  evaluatedAt: z.unknown().optional()
});

function freezeAuthorization<T extends AuthorizeMemoryAccessInput>(authorization: T): T {
  return Object.freeze({
    ...authorization,
    grantVersions: Object.freeze({ ...authorization.grantVersions })
  });
}

function freezeBinding(rawBinding: BoundMemoryCellBinding): BoundMemoryCellBinding {
  const parsed = BoundMemoryCellBindingSchema.parse(rawBinding);
  return Object.freeze({
    ...parsed,
    readAuthorization: freezeAuthorization(parsed.readAuthorization),
    proposeAuthorization: freezeAuthorization(parsed.proposeAuthorization)
  });
}

/**
 * A server-owned memory-system facade for exactly one principal, scope, sleeve,
 * and run. Every allowed operation obtains fresh authority before touching the
 * delegate, and caller-supplied identity fields are ignored rather than trusted.
 *
 * A full cell can create propose-only semantic/procedural candidates. A
 * run-bounded cell exposes only working state and append-only episodic writes;
 * its consolidation and procedure facades fail before their delegate methods run.
 */
export class BoundMemoryCell {
  readonly id: MemorySystemId;
  readonly capabilities: MemorySystemCapabilities;

  private readonly system: MemorySystem;
  private readonly access: BoundAgentAccess;
  private readonly cellBinding: BoundMemoryCellBinding;

  constructor(options: BoundMemoryCellOptions) {
    this.system = options.system;
    this.access = options.access;
    this.cellBinding = freezeBinding(options.binding);
    this.id = options.system.id;
    this.capabilities =
      this.cellBinding.tier === 'full'
        ? options.system.capabilities
        : Object.freeze({
            workingMemory: options.system.capabilities.workingMemory,
            consolidation: false,
            proceduralPromotion: false,
            storeClasses: Object.freeze(
              options.system.capabilities.storeClasses.filter(
                (storeClass) => storeClass === 'working' || storeClass === 'episodic'
              )
            )
          });
  }

  async write(rawInput: unknown): Promise<MemoryFragmentRecord> {
    const unbound = BoundFragmentInputSchema.parse(rawInput);
    const input = MemoryFragmentInputSchema.parse({
      ...unbound,
      ownerScopeId: this.cellBinding.ownerScopeId,
      sleeveId: this.cellBinding.sleeveId
    });
    if (storeClassForKind(input.kind) !== 'episodic') {
      throw new BoundMemoryCellPolicyError('durable_non_episodic_write');
    }
    return this.withAuthorization('propose', input.sensitivity, () => this.system.write(input));
  }

  async retrieve(rawQuery: unknown): Promise<LexicalRetrievalResult> {
    const unbound = BoundRetrievalQuerySchema.parse(rawQuery);
    const query = LexicalRetrievalQuerySchema.parse({
      ...unbound,
      authorization: this.cellBinding.readAuthorization
    });
    return this.withAuthorization('read', query.authorization.sensitivity, () =>
      this.system.retrieve(query)
    );
  }

  async compileContext(rawInput: unknown): Promise<ScopedContextCompilation> {
    const unbound = BoundContextInputSchema.parse(rawInput);
    return this.withAuthorization('read', undefined, (authorization) => {
      const input = ScopedContextCompilerInputSchema.parse({
        ...unbound,
        ownerScopeId: this.cellBinding.ownerScopeId,
        sleeveId: this.cellBinding.sleeveId,
        evaluatedAt: authorization.authorizedAt
      });
      return Promise.resolve(this.system.compileContext(input));
    });
  }

  workingMemory(): WorkingMemoryStore | null {
    const delegate = this.system.workingMemory();
    if (delegate === null) {
      return null;
    }
    return Object.freeze({
      record: async (rawInput: unknown) => {
        const unbound = BoundWorkingEntrySchema.parse(rawInput);
        const input = WorkingMemoryEntryInputSchema.parse({
          ...unbound,
          ownerScopeId: this.cellBinding.ownerScopeId,
          sleeveId: this.cellBinding.sleeveId,
          runId: this.cellBinding.runId
        });
        return this.withAuthorization('propose', input.sensitivity, () => delegate.record(input));
      },
      read: async (rawQuery: unknown) => {
        const unbound = BoundWorkingReadSchema.parse(rawQuery);
        return this.withAuthorization('read', undefined, (authorization) => {
          const query = WorkingMemoryReadQuerySchema.parse({
            ...unbound,
            ownerScopeId: this.cellBinding.ownerScopeId,
            sleeveId: this.cellBinding.sleeveId,
            runId: this.cellBinding.runId,
            evaluatedAt: authorization.authorizedAt
          });
          return delegate.read(query);
        });
      }
    });
  }

  consolidation(): ConsolidationProposalStore | null {
    const delegate = this.system.consolidation();
    if (delegate === null) {
      return null;
    }
    if (this.cellBinding.tier === 'run_bounded') {
      return Object.freeze({
        propose: () => Promise.reject(new BoundMemoryCellPolicyError('consolidation_proposal')),
        listOpen: () =>
          Promise.reject(new BoundMemoryCellPolicyError('consolidation_candidate_list'))
      });
    }
    return Object.freeze({
      propose: async (rawInput: unknown) => {
        const unbound = BoundConsolidationInputSchema.parse(rawInput);
        const sensitivity = AccessSensitivityFrom(unbound.sensitivity);
        return this.withAuthorization('propose', sensitivity, (authorization) => {
          const input = ConsolidationCandidateInputSchema.parse({
            ...unbound,
            ownerScopeId: this.cellBinding.ownerScopeId,
            sleeveId: this.cellBinding.sleeveId,
            proposedBy: authorization.agentId
          });
          return delegate.propose(input);
        });
      },
      listOpen: async (rawQuery: unknown) => {
        const unbound = BoundConsolidationQuerySchema.parse(rawQuery);
        return this.withAuthorization('read', undefined, (authorization) => {
          const query = ConsolidationCandidateQuerySchema.parse({
            ...unbound,
            ownerScopeId: this.cellBinding.ownerScopeId,
            sleeveId: this.cellBinding.sleeveId,
            evaluatedAt: authorization.authorizedAt
          });
          return delegate.listOpen(query);
        });
      }
    });
  }

  procedures(): ProceduralPromotionStore | null {
    const delegate = this.system.procedures();
    if (delegate === null) {
      return null;
    }
    if (this.cellBinding.tier === 'run_bounded') {
      return Object.freeze({
        propose: () => Promise.reject(new BoundMemoryCellPolicyError('procedure_proposal')),
        listOpen: () => Promise.reject(new BoundMemoryCellPolicyError('procedure_candidate_list'))
      });
    }
    return Object.freeze({
      propose: async (rawInput: unknown) => {
        const unbound = BoundProcedureInputSchema.parse(rawInput);
        const sensitivity = AccessSensitivityFrom(unbound.sensitivity);
        return this.withAuthorization('propose', sensitivity, (authorization) => {
          const input = ProcedureCandidateInputSchema.parse({
            ...unbound,
            ownerScopeId: this.cellBinding.ownerScopeId,
            sleeveId: this.cellBinding.sleeveId,
            proposedBy: authorization.agentId
          });
          return delegate.propose(input);
        });
      },
      listOpen: async (rawQuery: unknown) => {
        const unbound = BoundProcedureQuerySchema.parse(rawQuery);
        return this.withAuthorization('read', undefined, (authorization) => {
          const query = ProcedureCandidateQuerySchema.parse({
            ...unbound,
            ownerScopeId: this.cellBinding.ownerScopeId,
            sleeveId: this.cellBinding.sleeveId,
            evaluatedAt: authorization.authorizedAt
          });
          return delegate.listOpen(query);
        });
      }
    });
  }

  private withAuthorization<T>(
    permission: 'read' | 'propose',
    sensitivity: AccessSensitivity | undefined,
    operation: (authorization: AuthorizedMemoryAccess) => Promise<T>
  ): Promise<T> {
    const template: AuthorizeMemoryAccessInput =
      permission === 'read'
        ? this.cellBinding.readAuthorization
        : this.cellBinding.proposeAuthorization;
    const request: AuthorizeMemoryAccessInput = {
      ...template,
      permission,
      sensitivity: sensitivity ?? template.sensitivity
    };
    return this.access.runAuthorizedMemoryAccess(request, async (authorization) => {
      this.assertExactBinding(authorization, permission);
      return operation(authorization);
    });
  }

  private assertExactBinding(
    authorization: AuthorizedMemoryAccess,
    permission: 'read' | 'propose'
  ): void {
    if (
      authorization.agentId !== this.cellBinding.agentId ||
      authorization.ownerScopeId !== this.cellBinding.ownerScopeId ||
      authorization.sleeveId !== this.cellBinding.sleeveId ||
      authorization.permission !== permission
    ) {
      throw new BoundMemoryCellBindingError();
    }
  }
}

function AccessSensitivityFrom(value: unknown): AccessSensitivity {
  return z.enum(['public', 'internal', 'confidential', 'private', 'restricted']).parse(value);
}
