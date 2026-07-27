import type { TaskFrequencyRecord } from '../db/task-frequency-repository';

export interface FrequencyReader {
  findAtOrAbove(minimumExecutionCount: number, limit?: number): Promise<TaskFrequencyRecord[]>;
}

export interface ToolSmithProposal {
  kind: 'autonomous_pr_simulation';
  mode: 'proposal_only';
  skill: '5-d-build';
  taskSignature: string;
  executionCount: number;
  payload: {
    objective: string;
    evidence: {
      executionCount: number;
      averageDurationSeconds: number | null;
      manualInterventionCount: number;
      lastExecutedAt: string;
    };
  };
}

export interface ToolSmithOptions {
  frequency: FrequencyReader;
  threshold?: number;
  proposalLimit?: number;
}

export class ToolSmith {
  private readonly threshold: number;
  private readonly proposalLimit: number;

  constructor(private readonly options: ToolSmithOptions) {
    this.threshold = options.threshold ?? 5;

    if (!Number.isInteger(this.threshold) || this.threshold <= 0) {
      throw new RangeError('threshold must be a positive integer');
    }

    this.proposalLimit = options.proposalLimit ?? 10;
    if (
      !Number.isInteger(this.proposalLimit) ||
      this.proposalLimit <= 0 ||
      this.proposalLimit > 100
    ) {
      throw new RangeError('proposalLimit must be an integer between 1 and 100');
    }
  }

  async analyze(): Promise<ToolSmithProposal[]> {
    const records = await this.options.frequency.findAtOrAbove(this.threshold, this.proposalLimit);

    return records.map((record) => this.createProposal(record));
  }

  private createProposal(record: TaskFrequencyRecord): ToolSmithProposal {
    return {
      kind: 'autonomous_pr_simulation',
      mode: 'proposal_only',
      skill: '5-d-build',
      taskSignature: record.taskSignature,
      executionCount: record.executionCount,
      payload: {
        objective: `Automate repeated task: ${record.taskSignature}`,
        evidence: {
          executionCount: record.executionCount,
          averageDurationSeconds: record.avgDurationSeconds,
          manualInterventionCount: record.manualInterventionCount,
          lastExecutedAt: record.lastExecutedAt
        }
      }
    };
  }
}
