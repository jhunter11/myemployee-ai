import { describe, expect, it } from 'vitest';

import {
  DIFFICULTY_TIERS,
  WORKLOAD_FAMILIES,
  WorkloadItemSchema,
  difficultyVectorMatchesTier,
  type DifficultyTier,
  type WorkloadFamily,
  type WorkloadItem
} from '../../../src/memory/experiment/contracts';
import {
  WorkloadContaminationError,
  assertNoContamination,
  findContamination,
  generateWorkload,
  type GeneratedWorkloadItem
} from '../../../src/memory/experiment/workload-generator';

const ALL_FAMILIES: readonly WorkloadFamily[] = WORKLOAD_FAMILIES;
const ALL_TIERS: readonly DifficultyTier[] = DIFFICULTY_TIERS;

function fullGrid(seed: number, historyCount = 64) {
  return generateWorkload({
    seed,
    families: [...ALL_FAMILIES],
    tiers: [...ALL_TIERS],
    historyCount
  });
}

const WORKLOAD = fullGrid(17);

function itemsOfTier(tier: DifficultyTier): readonly GeneratedWorkloadItem[] {
  return WORKLOAD.items.filter((generated) => generated.item.tier === tier);
}

function itemsOfFamily(family: WorkloadFamily): readonly GeneratedWorkloadItem[] {
  return WORKLOAD.items.filter((generated) => generated.item.family === family);
}

function withFirstMessageText(item: WorkloadItem, text: string): WorkloadItem {
  return {
    ...item,
    sessions: item.sessions.map((session, sessionIndex) =>
      sessionIndex === 0
        ? {
            ...session,
            messages: session.messages.map((message, messageIndex) =>
              messageIndex === 0 ? { ...message, text } : message
            )
          }
        : session
    )
  };
}

function firstItem(): GeneratedWorkloadItem {
  const generated = WORKLOAD.items[0];
  if (generated === undefined) throw new Error('the fixture workload is empty');
  return generated;
}

function promptSurface(generated: GeneratedWorkloadItem): string {
  return [
    generated.item.task.query,
    ...generated.item.sessions.flatMap((session) =>
      session.messages.map((message) => message.text)
    ),
    ...generated.artifacts.flatMap((artifact) => [artifact.title, artifact.body])
  ].join('\n');
}

describe('workload generator determinism', () => {
  it('emits byte-identical items for the same seed, including order', () => {
    const left = fullGrid(17, 16);
    const right = fullGrid(17, 16);
    expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    expect(left.fingerprint).toBe(right.fingerprint);
    expect(left.items.map((generated) => generated.item.historyHash)).toEqual(
      right.items.map((generated) => generated.item.historyHash)
    );
  });

  it('emits a different workload for a different seed', () => {
    expect(fullGrid(17, 16).fingerprint).not.toBe(fullGrid(18, 16).fingerprint);
    expect(fullGrid(17, 16).items[0]?.item.historyHash).not.toBe(
      fullGrid(18, 16).items[0]?.item.historyHash
    );
  });

  it('gives every item a distinct, stable history hash', () => {
    const hashes = WORKLOAD.items.map((generated) => generated.item.historyHash);
    expect(new Set(hashes).size).toBe(hashes.length);
    for (const hash of hashes) expect(hash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('keeps earlier items unchanged when the split grows', () => {
    // Each item draws from its own named stream, so extending a split must never
    // rewrite the items an earlier run already scored.
    const small = fullGrid(21, 8);
    const large = fullGrid(21, 40);
    expect(JSON.stringify(large.items.slice(0, 8))).toBe(JSON.stringify(small.items));
  });

  it('re-validates every generated item against the item contract', () => {
    for (const generated of WORKLOAD.items) {
      expect(() => WorkloadItemSchema.parse(generated.item)).not.toThrow();
    }
  });
});

describe('workload taxonomy coverage', () => {
  it('covers all eight families and all four tiers, balanced by grid cell', () => {
    expect(new Set(WORKLOAD.items.map((generated) => generated.item.family))).toEqual(
      new Set(ALL_FAMILIES)
    );
    expect(new Set(WORKLOAD.items.map((generated) => generated.item.tier))).toEqual(
      new Set(ALL_TIERS)
    );
    for (const family of ALL_FAMILIES) {
      for (const tier of ALL_TIERS) {
        const cell = WORKLOAD.items.filter(
          (generated) => generated.item.family === family && generated.item.tier === tier
        );
        expect(cell).toHaveLength(2);
      }
    }
  });

  it('honours a narrowed family/tier request', () => {
    const narrowed = generateWorkload({
      seed: 3,
      families: ['adversarial'],
      tiers: ['hard'],
      historyCount: 3
    });
    expect(narrowed.items).toHaveLength(3);
    for (const generated of narrowed.items) {
      expect(generated.item.family).toBe('adversarial');
      expect(generated.item.tier).toBe('hard');
    }
  });

  it('rejects generator inputs that would unbalance the sample', () => {
    expect(() =>
      generateWorkload({
        seed: 1,
        families: ['reasoning', 'reasoning'],
        tiers: ['easy'],
        historyCount: 2
      })
    ).toThrow();
    expect(() =>
      generateWorkload({
        seed: 1,
        families: ['reasoning'],
        tiers: ['easy', 'easy'],
        historyCount: 2
      })
    ).toThrow();
    expect(() =>
      generateWorkload({ seed: 1, families: ['reasoning'], tiers: ['easy'], historyCount: 0 })
    ).toThrow();
    expect(() =>
      generateWorkload({ seed: 1.5, families: ['reasoning'], tiers: ['easy'], historyCount: 2 })
    ).toThrow();
    expect(() =>
      generateWorkload({ seed: 1, families: ['not_a_family'], tiers: ['easy'], historyCount: 2 })
    ).toThrow();
  });
});

describe('difficulty tiers', () => {
  it('classifies every item into the tier it claims', () => {
    for (const generated of WORKLOAD.items) {
      expect(difficultyVectorMatchesTier(generated.difficulty, generated.item.tier)).toBe(true);
    }
  });

  it('is strictly monotone in sessions, updates, scopes, and distractors', () => {
    const knobs = ['sessionCount', 'updateCount', 'distractorCount'] as const;
    for (let index = 1; index < ALL_TIERS.length; index += 1) {
      const easier = ALL_TIERS[index - 1];
      const harder = ALL_TIERS[index];
      if (easier === undefined || harder === undefined) throw new Error('tier list is malformed');
      for (const knob of knobs) {
        const easierMax = Math.max(...itemsOfTier(easier).map((item) => item.difficulty[knob]));
        const harderMin = Math.min(...itemsOfTier(harder).map((item) => item.difficulty[knob]));
        expect(harderMin).toBeGreaterThan(easierMax);
      }
      const easierScopes = Math.max(
        ...itemsOfTier(easier).map((item) => item.difficulty.sleeveCount)
      );
      const harderScopes = Math.min(
        ...itemsOfTier(harder).map((item) => item.difficulty.sleeveCount)
      );
      expect(harderScopes).toBeGreaterThan(easierScopes);
    }
  });

  it('grows the realized history, not just the declared knobs', () => {
    const easyMessages = Math.max(
      ...itemsOfTier('easy').map((generated) =>
        generated.item.sessions.reduce((total, session) => total + session.messages.length, 0)
      )
    );
    const veryHardMessages = Math.min(
      ...itemsOfTier('very_hard').map((generated) =>
        generated.item.sessions.reduce((total, session) => total + session.messages.length, 0)
      )
    );
    expect(veryHardMessages).toBeGreaterThan(easyMessages);
    expect(
      Math.min(...itemsOfTier('very_hard').map((g) => g.item.groundTruth.nodes.length))
    ).toBeGreaterThan(Math.max(...itemsOfTier('easy').map((g) => g.item.groundTruth.nodes.length)));
  });
});

describe('four synchronized views', () => {
  it('keeps the session script, tool trace, artifact bundle, and graph consistent', () => {
    for (const generated of WORKLOAD.items) {
      const nodeIds = new Set(generated.item.groundTruth.nodes.map((node) => node.id));
      const sessionIds = new Set(generated.item.sessions.map((session) => session.sessionId));
      expect(generated.item.sessions.length).toBeGreaterThan(0);
      expect(generated.artifacts.length).toBeGreaterThan(0);

      for (const artifact of generated.artifacts) {
        expect(nodeIds.has(artifact.artifactId)).toBe(true);
        expect(sessionIds.has(artifact.producedInSessionId)).toBe(true);
        expect(artifact.itemId).toBe(generated.item.itemId);
        expect(artifact.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
      }
      const artifactNodes = new Set(
        generated.item.groundTruth.nodes
          .filter((node) => node.type === 'artifact')
          .map((node) => node.id)
      );
      for (const artifact of generated.artifacts) {
        expect(artifactNodes.has(artifact.artifactId)).toBe(true);
      }
      for (const event of generated.item.toolTrace) {
        expect(sessionIds.has(event.sessionId)).toBe(true);
      }
      for (const session of generated.item.sessions) {
        for (const message of session.messages) {
          if (message.realizesNodeId !== null) {
            expect(nodeIds.has(message.realizesNodeId)).toBe(true);
          }
        }
      }
    }
  });

  it('anchors the query after the history and never on a wall clock', () => {
    for (const generated of WORKLOAD.items) {
      const lastSession = generated.item.sessions[generated.item.sessions.length - 1];
      expect(lastSession).toBeDefined();
      if (lastSession === undefined) continue;
      expect(Date.parse(generated.item.queryTime)).toBeGreaterThan(
        Date.parse(lastSession.startedAt)
      );
    }
  });
});

describe('update control cohort', () => {
  it('generates genuine supersession, deletion, and revocation chains', () => {
    const items = itemsOfFamily('update_control');
    expect(items.length).toBeGreaterThan(0);
    for (const generated of items) {
      const supersedes = generated.item.groundTruth.edges.filter(
        (edge) => edge.type === 'supersedes'
      );
      const revokes = generated.item.groundTruth.edges.filter((edge) => edge.type === 'revokes');
      expect(supersedes.length).toBeGreaterThanOrEqual(1);
      expect(revokes.length).toBeGreaterThanOrEqual(1);
      expect(
        generated.item.attackLabels.some((label) => label.family === 'deletion_resurrection')
      ).toBe(true);
    }
  });

  it('produces both a surviving-head cohort and a revoked cohort', () => {
    const modes = itemsOfFamily('update_control').map(
      (generated) => generated.item.task.expected.mode
    );
    expect(modes).toContain('exact_answer');
    expect(modes).toContain('abstain');
  });

  it('never gives an abstention primary gold evidence', () => {
    for (const generated of WORKLOAD.items) {
      const expected = generated.item.task.expected;
      if (expected.mode !== 'abstain') continue;
      expect(expected.evidence.some((entry) => entry.grade === 'primary')).toBe(false);
      expect(['revoked', 'out_of_scope']).toContain(expected.reason);
    }
  });

  it('supersedes to a genuinely different value at every link of the chain', () => {
    for (const generated of itemsOfFamily('update_control')) {
      const revisions = generated.item.groundTruth.nodes
        .filter((node) => node.id.startsWith('rev_'))
        .map((node) => String(node.attributes.canonical_value));
      for (let index = 1; index < revisions.length; index += 1) {
        expect(revisions[index]).not.toBe(revisions[index - 1]);
      }
    }
  });
});

describe('adversarial cohort', () => {
  it('plants injection, poisoning, inference bait, and a similar out-of-scope item', () => {
    const items = itemsOfFamily('adversarial');
    expect(items.length).toBeGreaterThan(0);
    for (const generated of items) {
      const families = generated.item.attackLabels.map((label) => label.family);
      expect(families).toContain('memory_injection');
      expect(families).toContain('poisoned_artifact');
      expect(
        families.includes('similar_sleeve_distractor') || families.includes('out_of_scope_probe')
      ).toBe(true);
      expect(
        generated.item.groundTruth.nodes.some(
          (node) => node.attributes.attack_kind === 'unsupported_inference'
        )
      ).toBe(true);
      for (const label of generated.item.attackLabels) {
        expect(label.mustNotSurfaceNodeIds.length).toBeGreaterThan(0);
      }
      expect(generated.artifacts.some((artifact) => artifact.artifactId.includes('_doc'))).toBe(
        true
      );
    }
  });

  it('never lets the poisoned claim become the gold answer', () => {
    for (const generated of itemsOfFamily('adversarial')) {
      const poisoned = generated.item.groundTruth.nodes.filter(
        (node) => node.attributes.attack === true
      );
      expect(poisoned.length).toBeGreaterThan(0);
      for (const node of poisoned) {
        expect(
          generated.item.task.expected.evidence.some((entry) => entry.nodeId === node.id)
        ).toBe(false);
      }
    }
  });

  it('answers an out-of-scope probe with abstention rather than a neighbouring value', () => {
    const probes = itemsOfFamily('adversarial').filter((generated) =>
      generated.item.attackLabels.some((label) => label.family === 'out_of_scope_probe')
    );
    expect(probes.length).toBeGreaterThan(0);
    for (const generated of probes) {
      expect(generated.item.task.expected.mode).toBe('abstain');
    }
  });
});

describe('ambiguity without subjective gold', () => {
  it('stores an absolute instant plus its reference anchor behind a relative phrase', () => {
    const deadlines = itemsOfFamily('project_state');
    expect(deadlines.length).toBeGreaterThan(0);
    for (const generated of deadlines) {
      const revisions = generated.item.groundTruth.nodes.filter((node) => node.type === 'deadline');
      expect(revisions.length).toBeGreaterThan(0);
      for (const revision of revisions) {
        const canonical = String(revision.attributes.canonical_value);
        const anchor = String(revision.attributes.reference_anchor);
        expect(canonical).toMatch(/^\d{4}-\d{2}-\d{2}T17:00:00\.000Z$/u);
        expect(Date.parse(canonical)).toBeGreaterThan(Date.parse(anchor));
        // The absolute instant is never on the prompt-visible surface; only the
        // relative phrase is, so the item tests temporal normalization.
        expect(promptSurface(generated)).not.toContain(canonical);
      }
      const surface = promptSurface(generated);
      expect(/next (Monday|Tuesday|Wednesday|Thursday|Friday)/u.test(surface)).toBe(true);
    }
  });

  it('qualifies an ambiguous surface question with a unique in-scope graph node', () => {
    const ambiguous = WORKLOAD.items.filter((generated) =>
      /usual|normally|usually/u.test(generated.item.task.query)
    );
    expect(ambiguous.length).toBeGreaterThan(0);
    for (const generated of ambiguous) {
      const primary = generated.item.task.expected.evidence.filter(
        (entry) => entry.grade === 'primary'
      );
      expect(primary.length).toBeLessThanOrEqual(1);
      const neighbour = generated.item.groundTruth.nodes.find((node) => node.id.startsWith('nbr_'));
      const head = generated.item.groundTruth.nodes
        .filter((node) => node.id.startsWith('rev_'))
        .slice(-1)[0];
      expect(neighbour).toBeDefined();
      expect(head).toBeDefined();
      // Two scopes hold the "usual" value; the graph keeps them distinct.
      expect(neighbour?.attributes.canonical_value).not.toBe(head?.attributes.canonical_value);
    }
  });
});

describe('contamination control', () => {
  it('finds no gold material on any prompt-visible surface', () => {
    for (const generated of WORKLOAD.items) {
      expect(findContamination(generated)).toBeNull();
      expect(() => assertNoContamination(generated)).not.toThrow();
    }
  });

  it('keeps the composed gold answer out of the evaluation payload entirely', () => {
    for (const generated of WORKLOAD.items) {
      const composed = generated.goldStrings[generated.goldStrings.length - 1];
      if (composed === undefined || !composed.includes('=')) continue;
      expect(JSON.stringify(generated.item)).not.toContain(composed);
    }
  });

  it('catches a deliberately leaked gold answer string', () => {
    const generated = firstItem();
    const composed = generated.goldStrings[generated.goldStrings.length - 1];
    expect(composed).toBeDefined();
    if (composed === undefined) return;
    const leaked = withFirstMessageText(generated.item, `As a reminder the answer is ${composed}.`);
    const finding = findContamination({ ...generated, item: leaked });
    expect(finding).not.toBeNull();
    expect(finding?.kind).toBe('gold_answer_text');
    expect(finding?.surface).toBe('sessions[0].messages[0].text');
    expect(() => assertNoContamination({ ...generated, item: leaked })).toThrow(
      WorkloadContaminationError
    );
  });

  it('catches a leaked gold node id', () => {
    const generated = firstItem();
    const nodeId = generated.item.groundTruth.nodes[0]?.id;
    expect(nodeId).toBeDefined();
    if (nodeId === undefined) return;
    const leaked = withFirstMessageText(generated.item, `see ${nodeId} for the detail`);
    expect(findContamination({ ...generated, item: leaked })?.kind).toBe('node_id');
  });

  it('catches a leaked answer hash', () => {
    const generated = WORKLOAD.items.find(
      (candidate) => candidate.item.task.expected.mode === 'exact_answer'
    );
    expect(generated).toBeDefined();
    if (generated === undefined) return;
    const expected = generated.item.task.expected;
    if (expected.mode !== 'exact_answer') return;
    const leaked = withFirstMessageText(generated.item, `checksum ${expected.answerSha256}`);
    expect(findContamination({ ...generated, item: leaked })?.kind).toBe('answer_hash');
  });

  it('catches a leaked canonical node label', () => {
    const generated = firstItem();
    const projectNode = generated.item.groundTruth.nodes.find((node) => node.type === 'project');
    expect(projectNode).toBeDefined();
    if (projectNode === undefined) return;
    const leaked = withFirstMessageText(generated.item, `context: ${projectNode.label}`);
    expect(findContamination({ ...generated, item: leaked })?.kind).toBe('node_label');
  });

  it('catches a leaked status label', () => {
    const generated = firstItem();
    const leaked = withFirstMessageText(generated.item, 'that earlier note is superseded now');
    expect(findContamination({ ...generated, item: leaked })?.kind).toBe('status_label');
  });

  it('keeps secrets as typed placeholders rather than material', () => {
    const secrets = WORKLOAD.items.flatMap((generated) =>
      generated.item.groundTruth.nodes.filter((node) => node.type === 'secret')
    );
    expect(secrets.length).toBeGreaterThan(0);
    for (const secret of secrets) {
      expect(secret.attributes.placeholder).toBe('TOKEN_SECRET_REDACTED');
      for (const forbidden of ['api_key', 'credential', 'password', 'secret', 'token', 'value']) {
        expect(secret.attributes[forbidden]).toBeUndefined();
      }
    }
  });
});
