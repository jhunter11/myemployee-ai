import { execFile } from 'node:child_process';

import { z } from 'zod';

const KeychainLookupSchema = z.strictObject({
  service: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/),
  account: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/)
});

interface CommandRunner {
  (
    file: string,
    args: string[],
    options: { timeout: number; maxBuffer: number }
  ): Promise<{ stdout: string }>;
}

const defaultRunner: CommandRunner = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout) => {
      if (error) reject(new Error('Keychain process failed'));
      else resolve({ stdout });
    });
  });

export class MacOSKeychainSecretReader {
  private readonly run: CommandRunner;

  constructor(options: { run?: CommandRunner } = {}) {
    this.run = options.run ?? defaultRunner;
  }

  async read(input: unknown): Promise<string> {
    const lookup = KeychainLookupSchema.parse(input);
    let stdout: string;
    try {
      ({ stdout } = await this.run(
        '/usr/bin/security',
        ['find-generic-password', '-s', lookup.service, '-a', lookup.account, '-w'],
        { timeout: 5_000, maxBuffer: 16_384 }
      ));
    } catch {
      throw new Error('Keychain credential lookup failed');
    }
    const secret = stdout.trim();
    if (!secret || secret.length > 16_000 || secret.includes('\0')) {
      throw new Error('Keychain credential is missing or invalid');
    }
    return secret;
  }
}
