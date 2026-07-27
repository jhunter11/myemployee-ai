import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const projectRoot = join(__dirname, '..', '..');
const auditScript = join(projectRoot, 'scripts', 'remote-access-audit.sh');

interface CommandFailure extends Error {
  code?: number;
  stdout?: string;
  stderr?: string;
}

async function auditFailure(overrides: NodeJS.ProcessEnv): Promise<CommandFailure> {
  try {
    await execFileAsync('/bin/zsh', ['-f', auditScript], {
      env: { ...process.env, ...overrides },
      encoding: 'utf8',
      maxBuffer: 64 * 1024,
      timeout: 20_000
    });
  } catch (error) {
    return error as CommandFailure;
  }
  throw new Error('Expected the remote-access audit to fail closed');
}

describe('read-only remote-access audit', () => {
  it('has valid zsh syntax and no known host mutation command', async () => {
    await expect(execFileAsync('/bin/zsh', ['-n', auditScript])).resolves.toMatchObject({
      stdout: '',
      stderr: ''
    });

    const source = await readFile(auditScript, 'utf8');
    const forbiddenMutationPatterns = [
      /\bsudo\b/,
      /socketfilterfw\s+--(?:set|add|remove|block|unblock)/,
      /\bsharing\s+-(?:a|e|r)\b/,
      /\bdefaults\s+(?:write|delete|rename|import)\b/,
      /\bsysctl\s+-w\b/,
      /\broute\s+(?:add|change|delete|flush)\b/,
      /\blaunchctl\s+(?:bootstrap|bootout|enable|disable|kickstart|load|unload)\b/,
      /\bfdesetup\s+(?:enable|disable|changerecovery)\b/,
      /\b(?:chmod|chown|cp|install|mkdir|mv|networksetup|pmset|rm|systemsetup|touch)\b/,
      /\bcurl\b[^\n]*(?:--data|--form|--request|-[A-Za-z]*X)\b/
    ];

    for (const pattern of forbiddenMutationPatterns) {
      expect(source).not.toMatch(pattern);
    }
    const outputRedirectionTargets = [
      ...source.matchAll(/(?:^|\s)(?:[0-9])?>{1,2}\s*(?![=&])([^&\s;]+)/gm)
    ]
      .map((match) => match[1])
      .filter((target): target is string => target !== undefined);
    expect(new Set(outputRedirectionTargets)).toEqual(new Set(['/dev/null']));
    expect(source).toContain(
      'This script changes no system, sharing, firewall, or application settings.'
    );
    expect(source).toContain('audit_label="${JARVIS_AUDIT_LABEL:-com.aiagency.jarvis.gateway}"');
    expect(source).toContain('hardwired address is private or link-local');
    expect(source).toContain('hardwired interface does not carry the default route');
  });

  it.each([
    ['port', { JARVIS_AUDIT_PORT: 'not-a-port' }],
    ['interface', { JARVIS_AUDIT_IF: '../bridge0' }],
    ['launchd label', { JARVIS_AUDIT_LABEL: 'system/com.jarvis.gateway' }]
  ])('rejects an invalid %s selector before inspecting the host', async (_name, overrides) => {
    const failure = await auditFailure(overrides);

    expect(failure.code).toBe(64);
    expect(failure.stdout).toBe('');
    expect(failure.stderr).toContain('remote audit configuration rejected');
  });

  it('fails closed with bounded NO-GO evidence and never claims to enable remote access', async () => {
    const failure = await auditFailure({
      JARVIS_AUDIT_PORT: '65534',
      JARVIS_AUDIT_IF: 'jarvis_audit_missing0',
      JARVIS_AUDIT_LABEL: 'com.jarvis.audit.missing'
    });
    const output = failure.stdout ?? '';

    expect(failure.code).toBeGreaterThan(0);
    expect(output).toContain('NO-GO:');
    expect(output).toContain('No remote-access setting was changed.');
    expect(output).toContain('jarvis_audit_missing0 inactive or missing');
    expect(output).toContain('Jarvis launchd job absent');
    expect(output).not.toMatch(/\b(?:enabled|started|configured) remote access\b/i);
    expect(output.length).toBeLessThan(4096);
  });
});
