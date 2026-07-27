import type {
  FacelessUploadSessionPlan,
  UploadSessionBlock,
  UploadSessionStep
} from './faceless-content-workflow';

const CLOCK_START = 11;
const CLOCK_END = 16;

function clock(iso: string): string {
  return iso.slice(CLOCK_START, CLOCK_END);
}

function titleCaseKind(kind: UploadSessionStep['kind']): string {
  switch (kind) {
    case 'sign_in':
      return 'Sign in';
    case 'upload':
      return 'Upload';
    case 'verify':
      return 'Verify';
    case 'sign_out':
      return 'Sign out';
  }
}

function renderStep(step: UploadSessionStep): string[] {
  const heading = `- [ ] \`${clock(step.scheduledAt)}\` **${titleCaseKind(step.kind)}** (${step.durationMinutes} min)`;
  if (step.kind === 'upload') {
    const lines = [
      `${heading} — \`${step.itemId}\``,
      `      file: ${step.assetRef}`,
      `      asset digest: ${step.assetDigest}`
    ];
    for (const check of step.checklist) {
      lines.push(`  - [ ] ${check.replaceAll('_', ' ')}`);
    }
    return lines;
  }
  return [`${heading} — ${step.instruction}`];
}

function renderBlock(block: UploadSessionBlock): string[] {
  const lines = [
    '',
    `## Block ${block.blockIndex + 1} — ${block.platform} ${block.publicLabel} (${block.role})`,
    `_${block.uploadCount} upload${block.uploadCount === 1 ? '' : 's'} · ${block.estimatedMinutes} min · connection \`${block.connectionId}\` · sign in from your password manager_`,
    ''
  ];
  for (const step of block.steps) {
    lines.push(...renderStep(step));
  }
  return lines;
}

function renderCompletionLog(plan: FacelessUploadSessionPlan): string[] {
  const lines = [
    '',
    '## Completion log — record every published item before the hour ends',
    '',
    '| itemId | accountId | publicPostUrl | postedAt | disclosureApplied | incidentNotes |',
    '| ------ | --------- | ------------- | -------- | ----------------- | ------------- |'
  ];
  for (const block of plan.blocks) {
    for (const step of block.steps) {
      if (step.kind === 'upload') {
        lines.push(`| ${step.itemId} | ${block.accountId} |  |  |  |  |`);
      }
    }
  }
  lines.push(
    '',
    `Set analytics checkpoints at ${plan.completionLog.analyticsCheckpoints.join(', ')}. ${plan.completionLog.instruction}`
  );
  return lines;
}

/**
 * Renders a session plan as a printable, checkbox-driven operator sheet. The
 * rendered sheet contains no credential: the plan already replaces every secret
 * with `credentialSource: operator_password_manager`, and this renderer only
 * reads plan fields.
 */
export function renderUploadSessionSheet(plan: FacelessUploadSessionPlan): string {
  const { totals } = plan;
  const lines = [
    `# Upload session — ${plan.sessionId}`,
    '',
    `Start ${plan.sessionStart} · portfolio \`${plan.portfolioId}\` · \`${plan.emailGroupId}\``,
    `Mode: ${plan.mode} · State: **${plan.sessionState}**`,
    '',
    '> Jarvis does not sign in, hold a platform password, or upload. You execute this sheet.',
    '',
    `**Plan:** ${totals.scheduledUploads} upload${totals.scheduledUploads === 1 ? '' : 's'} across ${totals.accountBlocks} account block${totals.accountBlocks === 1 ? '' : 's'} · ${totals.estimatedMinutes} of ${totals.sessionMinutes} min · ${totals.remainingMinutes} min slack · ${totals.deferredItems} deferred · ${totals.rejectedItems} rejected`
  ];

  for (const block of plan.blocks) {
    lines.push(...renderBlock(block));
  }

  if (plan.deferred.length > 0) {
    lines.push('', `## Deferred (${plan.deferred.length}) — carry to the next session`, '');
    for (const entry of plan.deferred) {
      lines.push(`- \`${entry.itemId}\` (${entry.accountId}) — ${entry.reason}`);
    }
  }

  if (plan.rejected.length > 0) {
    lines.push(
      '',
      `## Rejected (${plan.rejected.length}) — fix before re-queuing, not during the hour`,
      ''
    );
    for (const entry of plan.rejected) {
      lines.push(`- \`${entry.itemId}\` (${entry.accountId}) — ${entry.reasons.join(', ')}`);
    }
  }

  lines.push(...renderCompletionLog(plan));
  lines.push('');
  return lines.join('\n');
}
