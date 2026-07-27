import { describe, expect, it, vi } from 'vitest';

import { MacOSKeychainSecretReader } from '../../src/secrets/macos-keychain';

describe('macOS Keychain secret reader', () => {
  it('uses argument-safe security lookup and returns a bounded trimmed secret', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: 'private-token\n' });
    const reader = new MacOSKeychainSecretReader({ run });

    await expect(
      reader.read({ service: 'ai-agency-jarvis.telegram', account: 'operator-bot' })
    ).resolves.toBe('private-token');
    expect(run).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'ai-agency-jarvis.telegram', '-a', 'operator-bot', '-w'],
      { timeout: 5_000, maxBuffer: 16_384 }
    );
  });

  it('rejects unsafe identifiers and sanitizes command errors', async () => {
    const secret = 'never expose this secret';
    const run = vi.fn().mockRejectedValue(new Error(secret));
    const reader = new MacOSKeychainSecretReader({ run });

    await expect(
      reader.read({ service: 'ai-agency-jarvis.telegram', account: 'operator-bot' })
    ).rejects.toThrow('Keychain credential lookup failed');
    try {
      await reader.read({ service: 'ai-agency-jarvis.telegram', account: 'operator-bot' });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
    await expect(
      reader.read({ service: 'bad;service', account: 'operator-bot' })
    ).rejects.toThrow();
  });

  it.each([
    ['an empty credential', ''],
    ['a whitespace-only credential', '   \n\t  '],
    ['an oversized credential', `${'a'.repeat(16_001)}\n`],
    ['a NUL-injected credential', 'token\0injected']
  ])('rejects %s rather than returning it', async (_label, stdout) => {
    const run = vi.fn().mockResolvedValue({ stdout });
    const reader = new MacOSKeychainSecretReader({ run });

    await expect(
      reader.read({ service: 'ai-agency-jarvis.telegram', account: 'operator-bot' })
    ).rejects.toThrow('Keychain credential is missing or invalid');
  });

  it('rejects lookups whose account fails the identifier allowlist', async () => {
    const run = vi.fn();
    const reader = new MacOSKeychainSecretReader({ run });

    for (const account of ['a', '-leading-dash', 'has space', 'has/slash', '$(whoami)']) {
      await expect(
        reader.read({ service: 'ai-agency-jarvis.telegram', account })
      ).rejects.toThrow();
    }
    for (const input of [undefined, null, {}, { service: 'ai-agency-jarvis.telegram' }]) {
      await expect(reader.read(input)).rejects.toThrow();
    }
    await expect(
      reader.read({
        service: 'ai-agency-jarvis.telegram',
        account: 'operator-bot',
        extra: 'unexpected'
      })
    ).rejects.toThrow();
    expect(run).not.toHaveBeenCalled();
  });

  it('sanitizes failures from the real security binary when no runner is injected', async () => {
    const reader = new MacOSKeychainSecretReader();

    // A generic password that does not exist fails without prompting; on hosts
    // without /usr/bin/security the spawn itself fails through the same path.
    await expect(
      reader.read({
        service: 'ai-agency-jarvis.absent-test-entry',
        account: 'no-such-account'
      })
    ).rejects.toThrow('Keychain credential lookup failed');
  });
});
