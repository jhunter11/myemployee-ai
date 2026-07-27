import { execFile } from 'node:child_process';
import { readFile as fsReadFile } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

/**
 * The secrets plane inspects on-disk OAuth stores and the macOS Keychain to
 * answer one question per provider: is a usable credential present? It NEVER
 * returns, logs, or embeds token material — only a bounded, non-secret state and
 * a human-readable, secret-free `detail`. Actual token bytes are read elsewhere
 * (the provider adapters in the model layer), on demand, and are never persisted.
 */
export type CredentialProviderId = 'claude' | 'codex' | 'gemini' | 'telegram' | 'ollama';
export type CredentialState = 'valid' | 'expired' | 'missing' | 'malformed';

export interface CredentialStatus {
  provider: CredentialProviderId;
  state: CredentialState;
  source: string;
  detail: string;
}

export interface ProviderCredentialSource {
  readonly provider: CredentialProviderId;
  status(): Promise<CredentialStatus>;
}

export interface KeychainLookup {
  service: string;
  account?: string;
}

export interface SecretsPlaneDeps {
  homedir?: () => string;
  readFile?: (path: string) => Promise<string>;
  env?: Record<string, string | undefined>;
  keychainPresent?: (lookup: KeychainLookup) => Promise<boolean>;
  now?: () => number;
}

const KEYCHAIN_SERVICE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{2,127}$/u;
const KEYCHAIN_ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._@-]{0,127}$/u;

/**
 * Presence-only keychain probe: it runs `security find-generic-password`
 * WITHOUT `-w`/`-g`, so the secret is never emitted; only the process exit code
 * (found / not found) is observed.
 */
export function defaultKeychainPresent(lookup: KeychainLookup): Promise<boolean> {
  return new Promise((resolve) => {
    if (!KEYCHAIN_SERVICE_PATTERN.test(lookup.service)) {
      resolve(false);
      return;
    }
    if (lookup.account !== undefined && !KEYCHAIN_ACCOUNT_PATTERN.test(lookup.account)) {
      resolve(false);
      return;
    }
    const args = ['find-generic-password', '-s', lookup.service];
    if (lookup.account !== undefined) args.push('-a', lookup.account);
    execFile('/usr/bin/security', args, { timeout: 5_000, maxBuffer: 16_384 }, (error) => {
      resolve(!error);
    });
  });
}

type FileReadResult =
  { kind: 'value'; value: unknown } | { kind: 'missing' } | { kind: 'malformed' };

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

async function readJsonFile(
  readFile: (path: string) => Promise<string>,
  path: string
): Promise<FileReadResult> {
  let text: string;
  try {
    text = await readFile(path);
  } catch (error) {
    // ENOENT is a clean "missing"; any other read error (permission, IO) is
    // treated as malformed so an unreadable credential can never read as valid.
    return isMissingFileError(error) ? { kind: 'missing' } : { kind: 'malformed' };
  }
  try {
    return { kind: 'value', value: JSON.parse(text) as unknown };
  } catch {
    return { kind: 'malformed' };
  }
}

const CodexAuthSchema = z.object({
  auth_mode: z.string().max(64).optional(),
  tokens: z.object({
    access_token: z.string().min(1),
    refresh_token: z.string().min(1).optional()
  })
});

const GeminiAuthSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expiry_date: z.number().int().optional(),
  scope: z.string().optional()
});

const TelegramAllowSchema = z.object({
  allowFrom: z.array(z.union([z.number(), z.string()])),
  version: z.number().int()
});

class CodexCredentialSource implements ProviderCredentialSource {
  readonly provider = 'codex' as const;
  private readonly path: string;

  constructor(
    private readonly deps: Required<Pick<SecretsPlaneDeps, 'readFile'>> & { home: string }
  ) {
    this.path = join(deps.home, '.codex', 'auth.json');
  }

  async status(): Promise<CredentialStatus> {
    const source = '~/.codex/auth.json';
    const read = await readJsonFile(this.deps.readFile, this.path);
    if (read.kind === 'missing') {
      return {
        provider: this.provider,
        state: 'missing',
        source,
        detail: 'no ChatGPT/Codex auth.json found'
      };
    }
    const parsed = read.kind === 'value' ? CodexAuthSchema.safeParse(read.value) : undefined;
    if (!parsed?.success) {
      return {
        provider: this.provider,
        state: 'malformed',
        source,
        detail: 'auth.json is unreadable or missing tokens'
      };
    }
    const refresh = parsed.data.tokens.refresh_token !== undefined;
    const mode = parsed.data.auth_mode ?? 'unknown';
    return {
      provider: this.provider,
      state: 'valid',
      source,
      detail: `auth_mode=${mode}; refresh token ${refresh ? 'present' : 'absent'}`
    };
  }
}

class GeminiCredentialSource implements ProviderCredentialSource {
  readonly provider = 'gemini' as const;
  private readonly path: string;

  constructor(
    private readonly deps: Required<Pick<SecretsPlaneDeps, 'readFile' | 'now'>> & { home: string }
  ) {
    this.path = join(deps.home, '.gemini', 'oauth_creds.json');
  }

  async status(): Promise<CredentialStatus> {
    const source = '~/.gemini/oauth_creds.json';
    const read = await readJsonFile(this.deps.readFile, this.path);
    if (read.kind === 'missing') {
      return {
        provider: this.provider,
        state: 'missing',
        source,
        detail: 'no Gemini oauth_creds.json found'
      };
    }
    const parsed = read.kind === 'value' ? GeminiAuthSchema.safeParse(read.value) : undefined;
    if (!parsed?.success) {
      return {
        provider: this.provider,
        state: 'malformed',
        source,
        detail: 'oauth_creds.json is unreadable or missing an access token'
      };
    }
    const { refresh_token: refresh, expiry_date: expiry } = parsed.data;
    const expiresIso = expiry === undefined ? undefined : new Date(expiry).toISOString();
    const expired = expiry !== undefined && expiry <= this.deps.now();
    if (refresh !== undefined) {
      return {
        provider: this.provider,
        state: 'valid',
        source,
        detail: expiresIso
          ? `refresh token present; access token ${expired ? 'expired' : 'valid'} (expiry ${expiresIso})`
          : 'refresh token present'
      };
    }
    return expired
      ? {
          provider: this.provider,
          state: 'expired',
          source,
          detail: `access token expired ${expiresIso ?? ''}; no refresh token`.trim()
        }
      : {
          provider: this.provider,
          state: 'valid',
          source,
          detail: expiresIso ? `access token valid until ${expiresIso}` : 'access token present'
        };
  }
}

class ClaudeCredentialSource implements ProviderCredentialSource {
  readonly provider = 'claude' as const;

  constructor(private readonly deps: Required<Pick<SecretsPlaneDeps, 'env' | 'keychainPresent'>>) {}

  async status(): Promise<CredentialStatus> {
    const headless = this.deps.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (typeof headless === 'string' && headless.trim().length > 0) {
      return {
        provider: this.provider,
        state: 'valid',
        source: 'env:CLAUDE_CODE_OAUTH_TOKEN',
        detail: 'headless subscription token present in environment'
      };
    }
    const present = await this.deps.keychainPresent({ service: 'Claude Code-credentials' });
    return present
      ? {
          provider: this.provider,
          state: 'valid',
          source: 'macos-keychain:Claude Code-credentials',
          detail: 'subscription credential present in keychain'
        }
      : {
          provider: this.provider,
          state: 'missing',
          source: 'macos-keychain:Claude Code-credentials',
          detail:
            'no headless token and no keychain credential; run `claude` login or `claude setup-token`'
        };
  }
}

class TelegramCredentialSource implements ProviderCredentialSource {
  readonly provider = 'telegram' as const;
  private readonly path: string;

  constructor(
    private readonly deps: Required<Pick<SecretsPlaneDeps, 'readFile' | 'keychainPresent'>> & {
      home: string;
    }
  ) {
    this.path = join(deps.home, '.openclaw', 'credentials', 'telegram-default-allowFrom.json');
  }

  async status(): Promise<CredentialStatus> {
    const source = '~/.openclaw/credentials/telegram-default-allowFrom.json + keychain';
    const read = await readJsonFile(this.deps.readFile, this.path);
    if (read.kind === 'missing') {
      return {
        provider: this.provider,
        state: 'missing',
        source,
        detail: 'no OpenClaw Telegram allowlist found'
      };
    }
    const parsed = read.kind === 'value' ? TelegramAllowSchema.safeParse(read.value) : undefined;
    if (!parsed?.success || parsed.data.allowFrom.length === 0) {
      return {
        provider: this.provider,
        state: 'malformed',
        source,
        detail: 'allowlist is unreadable or empty'
      };
    }
    const allowCount = parsed.data.allowFrom.length;
    const tokenPresent = await this.deps.keychainPresent({
      service: 'ai-agency-jarvis.telegram',
      account: 'operator-bot'
    });
    return tokenPresent
      ? {
          provider: this.provider,
          state: 'valid',
          source,
          detail: `allowlist present (${allowCount} principal${allowCount === 1 ? '' : 's'}); bot token present in keychain`
        }
      : {
          provider: this.provider,
          state: 'missing',
          source,
          detail: `allowlist present (${allowCount} principal${allowCount === 1 ? '' : 's'}); bot token not in keychain (service ai-agency-jarvis.telegram)`
        };
  }
}

class OllamaCredentialSource implements ProviderCredentialSource {
  readonly provider = 'ollama' as const;

  status(): Promise<CredentialStatus> {
    return Promise.resolve({
      provider: this.provider,
      state: 'valid',
      source: 'local:ollama',
      detail: 'local runtime; no OAuth credential required (liveness is checked at runtime)'
    });
  }
}

export class ProviderCredentialInspector {
  private readonly sources: ProviderCredentialSource[];

  constructor(deps: SecretsPlaneDeps = {}) {
    const home = (deps.homedir ?? osHomedir)();
    const readFile = deps.readFile ?? ((path: string) => fsReadFile(path, 'utf8'));
    const env = deps.env ?? process.env;
    const keychainPresent = deps.keychainPresent ?? defaultKeychainPresent;
    const now = deps.now ?? Date.now;
    this.sources = [
      new ClaudeCredentialSource({ env, keychainPresent }),
      new CodexCredentialSource({ readFile, home }),
      new GeminiCredentialSource({ readFile, now, home }),
      new TelegramCredentialSource({ readFile, keychainPresent, home }),
      new OllamaCredentialSource()
    ];
  }

  statuses(): Promise<CredentialStatus[]> {
    return Promise.all(this.sources.map((source) => source.status()));
  }
}
