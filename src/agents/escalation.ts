import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import {
  AutomationIdSchema,
  ClientIdSchema,
  EscalationEventSchema,
  RunIdSchema,
  type EscalationEvent
} from '../config/schemas';
import { AppError } from '../utils/errors';

const NotificationSchema = z.strictObject({
  telegram: z.boolean(),
  telegram_priority: z.enum(['urgent', 'normal']).optional(),
  kanban: z.boolean(),
  auto_merge: z.boolean(),
  auto_patch: z.boolean()
});

const SeverityPolicySchema = z.strictObject({
  label: z.string().trim().min(1),
  definition: z.string().trim().min(1),
  agent_action: z.array(z.string().trim().min(1)).min(1),
  notification: NotificationSchema,
  human_sla: z.string().trim().min(1),
  auto_containment: z.boolean()
});

const EscalationPolicyFileSchema = z.strictObject({
  version: z.literal('1.0'),
  description: z.string().trim().min(1),
  severities: z.strictObject({
    P0: SeverityPolicySchema,
    P1: SeverityPolicySchema,
    P2: SeverityPolicySchema,
    P3: SeverityPolicySchema
  }),
  escalation_channels: z.strictObject({
    telegram: z.strictObject({
      owner_id: z.string().trim().min(1),
      urgent_prefix: z.string().trim().min(1),
      normal_prefix: z.string().trim().min(1)
    })
  }),
  fallback: z.string().trim().min(1)
});

export interface EscalationPolicyOptions {
  projectRoot: string;
}

export interface AutomationFailureInput {
  clientId: string;
  runId: string;
  automation: string;
  error: unknown;
  timestamp: string;
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === 'string' && error.trim().length > 0) return error.trim();
  return 'Unknown worker failure';
}

export class EscalationPolicy {
  private constructor(private readonly p1Actions: readonly string[]) {}

  static async load(options: EscalationPolicyOptions): Promise<EscalationPolicy> {
    try {
      const policyPath = join(options.projectRoot, 'config', 'escalation-policy.json');
      const metadata = await lstat(policyPath);
      if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new Error('Escalation policy must be a non-symlink regular file');
      }

      const parsed = EscalationPolicyFileSchema.parse(
        JSON.parse(await readFile(policyPath, 'utf8')) as unknown
      );
      return new EscalationPolicy([...parsed.severities.P1.agent_action]);
    } catch {
      throw new AppError(
        500,
        'INVALID_ESCALATION_POLICY',
        'Escalation policy configuration is invalid'
      );
    }
  }

  classifyAutomationFailure(input: AutomationFailureInput): EscalationEvent {
    const clientId = ClientIdSchema.parse(input.clientId);
    const automation = AutomationIdSchema.parse(input.automation);
    const runId = RunIdSchema.parse(input.runId);

    return EscalationEventSchema.parse({
      severity: 'P1',
      clientId,
      runId,
      eventDescription: `Automation ${automation} failed: ${failureMessage(input.error)}`,
      actions: [...this.p1Actions],
      resolved: false,
      timestamp: input.timestamp
    });
  }
}
