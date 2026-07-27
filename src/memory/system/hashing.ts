import { createHash } from 'node:crypto';

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Normalize a workflow's steps so trivially different phrasings hash identically. */
export function normalizeSteps(steps: readonly string[]): string[] {
  return steps.map((step) => step.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US'));
}

/**
 * Deterministic signature of a workflow's ordered steps. The planner and the
 * repository derive it the same way so a recurring workflow keeps a stable
 * signature across runs regardless of surface wording.
 */
export function workflowSignatureForSteps(steps: readonly string[]): string {
  return sha256(JSON.stringify(normalizeSteps(steps)));
}

/** Content hash for a consolidation candidate over its identity-bearing fields. */
export function consolidationContentHash(fields: {
  targetStore: string;
  proposedKind: string;
  title: string;
  content: string;
  temporalState: string;
  sourceFragmentIds: readonly string[];
}): string {
  return sha256(
    JSON.stringify({
      targetStore: fields.targetStore,
      proposedKind: fields.proposedKind,
      title: fields.title,
      content: fields.content,
      temporalState: fields.temporalState,
      sourceFragmentIds: [...fields.sourceFragmentIds].sort()
    })
  );
}

/** Content hash for a procedure candidate over its identity-bearing fields. */
export function procedureContentHash(fields: {
  workflowSignature: string;
  title: string;
  steps: readonly string[];
}): string {
  return sha256(
    JSON.stringify({
      workflowSignature: fields.workflowSignature,
      title: fields.title,
      steps: [...fields.steps]
    })
  );
}
