import { execFile } from 'node:child_process';

import { MacOSKeychainSecretReader } from '../../secrets/macos-keychain';
import type { ContentProviderId } from './contracts';

/**
 * Content-provider credential plane.
 *
 * The single switch that makes a credentialed connection go live: a provider's
 * key is resolved from an environment variable first, then the macOS Keychain.
 * Presence is probed WITHOUT ever emitting the secret; the value is read only at
 * call time, by the adapter that needs it, and never logged or returned upward.
 *
 * To connect a tool, the operator sets the env var OR adds the keychain entry —
 * no code change. That is what makes ElevenLabs/Higgsfield usable "the second
 * they are plugged in".
 */
export interface ContentCredentialConfig {
  envVar: string;
  keychainService: string;
  keychainAccount: string;
}

export const CONTENT_CREDENTIALS: Record<
  Exclude<ContentProviderId, 'local_say' | 'local_title_card'>,
  ContentCredentialConfig
> = {
  pexels: {
    envVar: 'PEXELS_API_KEY',
    keychainService: 'ai-agency-jarvis.pexels',
    keychainAccount: 'api-key'
  },
  elevenlabs: {
    envVar: 'ELEVENLABS_API_KEY',
    keychainService: 'ai-agency-jarvis.elevenlabs',
    keychainAccount: 'api-key'
  },
  higgsfield: {
    envVar: 'HIGGSFIELD_API_KEY',
    keychainService: 'ai-agency-jarvis.higgsfield',
    keychainAccount: 'api-key'
  }
};

export type CredentialedContentProviderId = keyof typeof CONTENT_CREDENTIALS;

export type CredentialSource = 'env' | 'keychain' | null;

export interface CredentialPresence {
  present: boolean;
  source: CredentialSource;
}

export interface ContentCredentialDeps {
  env?: Record<string, string | undefined>;
  /** Presence-only keychain probe; must never emit the secret. */
  keychainPresent?: (service: string, account: string) => Promise<boolean>;
  /** Call-time secret read; returns the raw value or throws. */
  keychainRead?: (service: string, account: string) => Promise<string>;
}

const KEYCHAIN_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,127}$/u;

function defaultKeychainPresent(service: string, account: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!KEYCHAIN_SERVICE_PATTERN.test(service)) {
      resolve(false);
      return;
    }
    execFile(
      '/usr/bin/security',
      ['find-generic-password', '-s', service, '-a', account],
      { timeout: 5_000, maxBuffer: 16_384 },
      (error) => resolve(!error)
    );
  });
}

function normalizeKey(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 16_000 && !trimmed.includes('\0') ? trimmed : null;
}

export class ContentCredentialResolver {
  private readonly env: Record<string, string | undefined>;
  private readonly keychainPresent: (service: string, account: string) => Promise<boolean>;
  private readonly keychainRead: (service: string, account: string) => Promise<string>;

  constructor(deps: ContentCredentialDeps = {}) {
    this.env = deps.env ?? process.env;
    this.keychainPresent = deps.keychainPresent ?? defaultKeychainPresent;
    const reader = new MacOSKeychainSecretReader();
    this.keychainRead =
      deps.keychainRead ?? ((service, account) => reader.read({ service, account }));
  }

  /** Secret-free presence check for status reporting. */
  async presence(provider: CredentialedContentProviderId): Promise<CredentialPresence> {
    const config = CONTENT_CREDENTIALS[provider];
    if (normalizeKey(this.env[config.envVar]) !== null) {
      return { present: true, source: 'env' };
    }
    const inKeychain = await this.keychainPresent(config.keychainService, config.keychainAccount);
    return inKeychain ? { present: true, source: 'keychain' } : { present: false, source: null };
  }

  /**
   * Reads the raw credential value for an outbound API call. Env wins over the
   * keychain. Throws when no credential is present so a missing key can never be
   * silently treated as an empty string.
   */
  async read(provider: CredentialedContentProviderId): Promise<string> {
    const config = CONTENT_CREDENTIALS[provider];
    const fromEnv = normalizeKey(this.env[config.envVar]);
    if (fromEnv !== null) return fromEnv;
    const fromKeychain = normalizeKey(
      await this.keychainRead(config.keychainService, config.keychainAccount).catch(() => undefined)
    );
    if (fromKeychain !== null) return fromKeychain;
    throw new Error(`No credential is connected for ${provider}`);
  }
}
