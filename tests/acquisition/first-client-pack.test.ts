import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = join(__dirname, '..', '..');
const packPath = join(projectRoot, 'docs', 'revenue', 'first-client-pack.json');

interface FirstClientPack {
  schema: string;
  asOf: string;
  offer: {
    blueprintMonthlyRange: {
      minimumUsd: number;
      minimumMicrousd: number;
      maximumUsd: number;
      maximumMicrousd: number;
    };
    foundingPilot: {
      firstMonthUsd: number;
      firstMonthMicrousd: number;
      standardMonthlyUsd: number;
      standardMonthlyMicrousd: number;
    };
  };
  sendGate: {
    state: string;
    operatorApprovalRequired: boolean;
    automationMaySend: boolean;
  };
  prospects: Array<{
    id: string;
    businessLabel: string;
    locationLabel: string;
    contactPageUrl: string;
    status: string;
    qualification: {
      score: number;
      maximumScore: number;
      publicSignals: string[];
      discoveryUnknowns: string[];
    };
    provenanceUrls: string[];
  }>;
}

async function loadPack(): Promise<FirstClientPack> {
  return JSON.parse(await readFile(packPath, 'utf8')) as FirstClientPack;
}

describe('first-client acquisition pack', () => {
  it('keeps price math exact in integer micro-USD and inside the approved blueprint', async () => {
    const pack = await loadPack();

    expect(pack.offer.blueprintMonthlyRange).toEqual({
      minimumUsd: 500,
      minimumMicrousd: 500_000_000,
      maximumUsd: 2_000,
      maximumMicrousd: 2_000_000_000
    });
    expect(pack.offer.foundingPilot).toMatchObject({
      firstMonthUsd: 750,
      firstMonthMicrousd: 750_000_000,
      standardMonthlyUsd: 1_250,
      standardMonthlyMicrousd: 1_250_000_000
    });
  });

  it('contains a bounded public-business shortlist without personal contact data', async () => {
    const pack = await loadPack();
    const serialized = JSON.stringify(pack);

    expect(pack.schema).toBe('jarvis.first-client-pack.v1');
    expect(pack.asOf).toBe('2026-07-18');
    expect(pack.prospects).toHaveLength(10);
    expect(new Set(pack.prospects.map(({ id }) => id)).size).toBe(10);
    expect(new Set(pack.prospects.map(({ contactPageUrl }) => contactPageUrl)).size).toBe(10);
    expect(serialized).not.toMatch(/@[A-Za-z0-9.-]+/);
    expect(serialized).not.toMatch(/"(?:email|phone|personalName|ownerName)"\s*:/i);

    for (const prospect of pack.prospects) {
      expect(prospect.businessLabel.length).toBeGreaterThan(2);
      expect(prospect.locationLabel).toBe('Charlotte metro, NC');
      expect(new URL(prospect.contactPageUrl).protocol).toBe('https:');
      expect(prospect.status).toBe('research_only');
      expect(prospect.qualification.maximumScore).toBe(5);
      expect(prospect.qualification.score).toBeGreaterThanOrEqual(3);
      expect(prospect.qualification.score).toBeLessThanOrEqual(5);
      expect(prospect.qualification.publicSignals.length).toBeGreaterThanOrEqual(3);
      expect(prospect.qualification.discoveryUnknowns).toEqual(
        expect.arrayContaining(['lead_volume', 'current_system', 'budget', 'decision_authority'])
      );
      expect(prospect.provenanceUrls.length).toBeGreaterThanOrEqual(1);
      for (const source of prospect.provenanceUrls) {
        expect(new URL(source).protocol).toBe('https:');
      }
    }
  });

  it('blocks outbound activity until a human reviews the exact recipient and message', async () => {
    const pack = await loadPack();
    const [readme, drafts, runbook, acceptance] = await Promise.all([
      readFile(join(projectRoot, 'docs', 'revenue', 'README.md'), 'utf8'),
      readFile(join(projectRoot, 'docs', 'revenue', 'outreach-drafts.md'), 'utf8'),
      readFile(join(projectRoot, 'docs', 'revenue', 'demo-runbook.md'), 'utf8'),
      readFile(join(projectRoot, 'docs', 'revenue', 'objections-and-acceptance.md'), 'utf8')
    ]);

    expect(pack.sendGate).toEqual(
      expect.objectContaining({
        state: 'blocked_pending_operator_review',
        operatorApprovalRequired: true,
        automationMaySend: false
      })
    );
    expect(readme).toContain('DO NOT SEND');
    expect(drafts).toContain('Draft only');
    expect(drafts).toContain('Website contact form');
    expect(drafts).toContain('Role-inbox email');
    expect(drafts).toContain('Manual phone opener');
    expect(runbook).toContain('qualifiedCount');
    expect(acceptance).toContain('Acceptance criteria');
    expect(acceptance).toContain('No revenue claim');
  });

  it('passes the deterministic local pack validator', async () => {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      join(projectRoot, 'scripts', 'revenue', 'validate-first-client-pack.mjs')
    ]);

    expect(stderr).toBe('');
    expect(stdout.trim()).toBe(
      'PASS first-client pack: 10 research-only prospects; outbound blocked'
    );
  });
});
