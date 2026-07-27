import { z } from 'zod';

import type { QueuePolicy, QueuePolicyBand } from './contracts';
import { QueuePolicySchema } from './contracts';

const TimestampSchema = z.iso.datetime();
const bandRank: Record<QueuePolicyBand, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
export const QUEUE_AGING_INTERVAL_MS = 15 * 60 * 1_000;
export const QUEUE_MAX_AGE_SCORE = 100;

export function comparePolicyBands(left: QueuePolicyBand, right: QueuePolicyBand): number {
  return bandRank[left] - bandRank[right];
}

export function basePolicyScore(input: QueuePolicy): number {
  const policy = QueuePolicySchema.parse(input);
  return policy.impact * 4 + policy.urgency * 5 + (11 - policy.effort);
}

export function scoreWithinBand(
  input: QueuePolicy,
  timestamps: { availableAt: string; now: string }
): { base: number; age: number; effective: number } {
  const availableAt = Date.parse(TimestampSchema.parse(timestamps.availableAt));
  const now = Date.parse(TimestampSchema.parse(timestamps.now));
  if (now < availableAt) {
    throw new RangeError('now must not precede availableAt');
  }
  const base = basePolicyScore(input);
  const age = Math.min(
    QUEUE_MAX_AGE_SCORE,
    Math.floor((now - availableAt) / QUEUE_AGING_INTERVAL_MS)
  );
  return { base, age, effective: base + age };
}
