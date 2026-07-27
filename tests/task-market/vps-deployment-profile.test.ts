import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const deploymentRoot = resolve(process.cwd(), 'deploy/task-market');
const composePath = resolve(deploymentRoot, 'compose.seller.json');
const environmentPath = resolve(deploymentRoot, 'task-market.testnet.env.example');
const readmePath = resolve(deploymentRoot, 'README.md');
const proxyPath = resolve(deploymentRoot, 'nginx.seller.conf');
const dockerfilePath = resolve(process.cwd(), 'Dockerfile.task-market');
const dockerignorePath = resolve(process.cwd(), '.dockerignore');

interface ComposeService {
  image?: string;
  entrypoint?: string[];
  user?: string;
  read_only?: boolean;
  cap_drop?: string[];
  security_opt?: string[];
  init?: boolean;
  privileged?: boolean;
  network_mode?: string;
  pid?: string;
  ipc?: string;
  pids_limit?: number;
  mem_limit?: string;
  cpus?: number;
  ports?: Array<
    | string
    | {
        target?: number;
        published?: string;
        protocol?: string;
        host_ip?: string;
      }
  >;
  command?: string[];
  extra_hosts?: string[];
  networks?: string[] | Record<string, { ipv4_address?: string; gw_priority?: number }>;
  configs?: Array<{
    source?: string;
    target?: string;
    mode?: number;
  }>;
  secrets?: Array<{
    source?: string;
    target?: string;
    uid?: string;
    gid?: string;
    mode?: number;
  }>;
  volumes?: Array<{
    type?: string;
    source?: string;
    target?: string;
    read_only?: boolean;
  }>;
  tmpfs?: string[];
  environment?: Record<string, string>;
  restart?: string;
  healthcheck?: {
    test?: string[];
    interval?: string;
    timeout?: string;
    retries?: number;
    start_period?: string;
  };
}

interface ComposeProfile {
  services: { seller: ComposeService } & Record<string, ComposeService>;
  networks?: Record<
    string,
    {
      driver?: string;
      internal?: boolean;
      ipam?: { config?: Array<{ subnet?: string }> };
    }
  >;
  volumes?: Record<string, { name?: string; external?: boolean }>;
  configs?: Record<string, { file?: string }>;
  secrets?: Record<string, { file?: string }>;
}

async function loadCompose(): Promise<ComposeProfile> {
  return JSON.parse(await readFile(composePath, 'utf8')) as ComposeProfile;
}

function parseExampleEnvironment(source: string): Record<string, string> {
  return Object.fromEntries(
    source
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => {
        const separator = line.indexOf('=');
        expect(separator).toBeGreaterThan(0);
        return [line.slice(0, separator), line.slice(separator + 1).replace(/^['"]|['"]$/g, '')];
      })
  );
}

describe('isolated task-market seller VPS profile', () => {
  it('publishes only the TLS proxy while keeping the seller behind two internal networks', async () => {
    const compose = await loadCompose();

    expect(Object.keys(compose.services)).toEqual(['tls_proxy', 'seller', 'facilitator_relay']);
    const seller = compose.services.seller;
    expect(seller.image).toMatch(/^\$\{TASK_MARKET_SELLER_IMAGE:/);
    expect(seller.ports).toBeUndefined();
    expect(seller.network_mode).not.toBe('host');
    expect(seller.pid).not.toBe('host');
    expect(seller.ipc).not.toBe('host');
    expect(seller.privileged).not.toBe(true);
    for (const forbiddenProperty of [
      'cap_add',
      'devices',
      'use_api_socket',
      'volumes_from',
      'secrets',
      'configs'
    ]) {
      expect(seller).not.toHaveProperty(forbiddenProperty);
    }

    const serialized = JSON.stringify(compose);
    expect(serialized).not.toMatch(/gateway|executor|docker\.sock/i);
    expect(seller.extra_hosts).toEqual(['x402.org:172.30.0.10']);
    expect(seller.networks).toEqual({
      seller_ingress: { ipv4_address: '172.30.0.3' },
      seller_facilitator: { ipv4_address: '172.30.0.11' }
    });

    const proxy = compose.services.tls_proxy;
    if (proxy === undefined) throw new Error('TLS proxy is missing');
    expect(proxy.image).toMatch(/^\$\{TASK_MARKET_PROXY_IMAGE:/);
    expect(proxy.ports).toEqual([
      { target: 8443, published: '443', protocol: 'tcp', host_ip: '0.0.0.0' }
    ]);
    expect(proxy.networks).toEqual({
      proxy_ingress: {},
      seller_ingress: { ipv4_address: '172.30.0.2' }
    });
    expect(proxy.volumes).toBeUndefined();

    const relay = compose.services.facilitator_relay;
    if (relay === undefined) throw new Error('facilitator relay is missing');
    expect(relay.ports).toBeUndefined();
    expect(relay.volumes).toBeUndefined();
    expect(relay.environment).toBeUndefined();
    expect(relay.command).toEqual(['node', 'facilitator-relay.mjs']);
    expect(relay.networks).toEqual({
      seller_facilitator: { ipv4_address: '172.30.0.10' },
      relay_egress: {}
    });
    expect(compose.networks).toMatchObject({
      seller_ingress: {
        driver: 'bridge',
        internal: true,
        ipam: { config: [{ subnet: '172.30.0.0/29' }] }
      },
      seller_facilitator: {
        driver: 'bridge',
        internal: true,
        ipam: { config: [{ subnet: '172.30.0.8/29' }] }
      },
      proxy_ingress: { driver: 'bridge', internal: false },
      relay_egress: { driver: 'bridge', internal: false }
    });
  });

  it('runs the public TLS proxy without Jarvis credentials or a writable root', async () => {
    const compose = await loadCompose();
    const proxy = compose.services.tls_proxy;
    if (proxy === undefined) throw new Error('TLS proxy is missing');

    expect(proxy.entrypoint).toEqual(['/usr/sbin/nginx']);
    expect(proxy.command).toEqual(['-g', 'daemon off; pid /tmp/nginx.pid;']);
    expect(proxy.user).toBe('101:101');
    expect(proxy.read_only).toBe(true);
    expect(proxy.cap_drop).toEqual(['ALL']);
    expect(proxy.security_opt).toContain('no-new-privileges:true');
    expect(proxy.privileged).not.toBe(true);
    expect(proxy.pids_limit).toBeLessThanOrEqual(64);
    expect(proxy.mem_limit).toBe('128m');
    expect(proxy.cpus).toBeLessThanOrEqual(0.25);
    expect(proxy.configs).toEqual([
      {
        source: 'seller_proxy',
        target: '/etc/nginx/conf.d/default.conf',
        mode: 292
      }
    ]);
    expect(proxy.secrets).toEqual([
      {
        source: 'seller_tls_certificate',
        target: '/run/secrets/seller_tls_certificate',
        uid: '101',
        gid: '101',
        mode: 292
      },
      {
        source: 'seller_tls_private_key',
        target: '/run/secrets/seller_tls_private_key',
        uid: '101',
        gid: '101',
        mode: 256
      }
    ]);
    expect(compose.configs).toEqual({
      seller_proxy: {
        file: '${TASK_MARKET_PROXY_CONFIG_FILE:?Set the rendered TLS proxy configuration file}'
      }
    });
    expect(compose.secrets).toEqual({
      seller_tls_certificate: {
        file: '${TASK_MARKET_TLS_CERTIFICATE_FILE:?Set the TLS certificate file}'
      },
      seller_tls_private_key: {
        file: '${TASK_MARKET_TLS_KEY_FILE:?Set the TLS private key file}'
      }
    });
    expect(proxy).not.toHaveProperty('environment');
    expect(JSON.stringify(proxy)).not.toMatch(
      /GITHUB|WALLET|JARVIS.*(?:DB|DATABASE)|(?:API|SIGNING)[_-]?KEY|TOKEN|PASSWORD|CREDENTIAL/i
    );
  });

  it('removes privileges and places hard resource ceilings around the seller', async () => {
    const seller = (await loadCompose()).services.seller;

    expect(seller.user).toBe('1000:1000');
    expect(seller.read_only).toBe(true);
    expect(seller.cap_drop).toEqual(['ALL']);
    expect(seller.security_opt).toContain('no-new-privileges:true');
    expect(seller.init).toBe(true);
    expect(seller.pids_limit).toBeGreaterThan(0);
    expect(seller.pids_limit).toBeLessThanOrEqual(128);
    expect(seller.mem_limit).toMatch(/^\d+[mMgG]$/);
    expect(Number(seller.cpus)).toBeGreaterThan(0);
    expect(Number(seller.cpus)).toBeLessThanOrEqual(1);
    expect(seller.tmpfs).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^\/tmp:.*size=16m/),
        expect.stringMatching(/^\/run:.*size=1m/)
      ])
    );
  });

  it('runs the fixed-destination relay without credentials, storage, or elevated privilege', async () => {
    const relay = (await loadCompose()).services.facilitator_relay;
    if (relay === undefined) throw new Error('facilitator relay is missing');

    expect(relay.user).toBe('1000:1000');
    expect(relay.read_only).toBe(true);
    expect(relay.cap_drop).toEqual(['ALL']);
    expect(relay.security_opt).toContain('no-new-privileges:true');
    expect(relay.privileged).not.toBe(true);
    expect(relay.pids_limit).toBeLessThanOrEqual(64);
    expect(relay.mem_limit).toBe('128m');
    expect(relay.cpus).toBeLessThanOrEqual(0.25);
    expect(JSON.stringify(relay)).not.toMatch(/SECRET|TOKEN|PASSWORD|KEY|CREDENTIAL/i);
  });

  it('makes only the dedicated settlement volume persistently writable', async () => {
    const compose = await loadCompose();
    const seller = compose.services.seller;

    expect(seller.volumes).toEqual([
      expect.objectContaining({
        type: 'volume',
        source: 'seller_settlements',
        target: '/var/lib/jarvis-task-market',
        read_only: false
      })
    ]);
    expect(compose.volumes).toEqual({
      seller_settlements: {
        name: 'jarvis_task_market_seller_settlements',
        external: true
      }
    });
    expect(seller.volumes?.every((mount) => mount.type === 'volume')).toBe(true);
    expect(JSON.stringify(seller.volumes)).not.toContain('/var/run/docker.sock');
  });

  it('starts disabled on exact Base Sepolia settings without control-plane credentials', async () => {
    const compose = await loadCompose();
    const sellerEnvironment = compose.services.seller.environment ?? {};
    const exampleEnvironment = parseExampleEnvironment(await readFile(environmentPath, 'utf8'));

    expect(sellerEnvironment).toMatchObject({
      NODE_ENV: 'production',
      TASK_MARKET_MODE: 'testnet',
      TASK_MARKET_NETWORK: 'eip155:84532',
      TASK_MARKET_FACILITATOR_URL: 'https://x402.org/facilitator',
      TASK_MARKET_HOST: '0.0.0.0',
      TASK_MARKET_PORT: '4021',
      TASK_MARKET_SETTLEMENT_LEDGER_PATH: '/var/lib/jarvis-task-market/settlements.sqlite',
      TASK_MARKET_ACCEPTING_WORK: '${TASK_MARKET_ACCEPTING_WORK:-false}'
    });
    expect(exampleEnvironment).toMatchObject({
      TASK_MARKET_MODE: 'testnet',
      TASK_MARKET_NETWORK: 'eip155:84532',
      TASK_MARKET_FACILITATOR_URL: 'https://x402.org/facilitator',
      TASK_MARKET_ACCEPTING_WORK: 'false'
    });

    const forbiddenCredentialKey =
      /SECRET|TOKEN|PASSWORD|CREDENTIAL|WALLET|GITHUB|^GH_|(?:API|PRIVATE|SIGNING)[_-]?KEY|JARVIS.*(?:DB|DATABASE)/i;
    for (const environmentKeys of [
      Object.keys(sellerEnvironment),
      Object.keys(exampleEnvironment)
    ]) {
      expect(environmentKeys).not.toEqual(
        expect.arrayContaining([expect.stringMatching(forbiddenCredentialKey)])
      );
    }
    expect(JSON.stringify(sellerEnvironment)).not.toMatch(/mainnet_enabled|eip155:8453(?:\D|$)/);
  });

  it('pins the build/runtime base and excludes task artifacts from the image context', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8');
    const dockerignore = await readFile(dockerignorePath, 'utf8');

    const pinnedBases = dockerfile.match(/^FROM node:22-bookworm-slim@sha256:[a-f0-9]{64}/gm);
    expect(pinnedBases).toHaveLength(2);
    expect(dockerfile).toContain('COPY deploy/task-market/facilitator-relay.mjs');
    expect(dockerignore.split('\n')).toContain('workspaces');
  });

  it('has bounded recovery and a local liveness check', async () => {
    const seller = (await loadCompose()).services.seller;

    expect(seller.restart).toBe('unless-stopped');
    expect(seller.healthcheck).toMatchObject({
      interval: '30s',
      timeout: '5s',
      retries: 3,
      start_period: '10s'
    });
    expect(seller.healthcheck?.test?.join(' ')).toContain('http://127.0.0.1:4021/livez');
  });

  it('checks in a fail-closed TLS proxy profile with exact routes and abuse ceilings', async () => {
    const proxy = await readFile(proxyPath, 'utf8');

    expect(proxy).toMatch(/listen 8443 ssl/);
    expect(proxy).toMatch(/listen 8443 ssl default_server/);
    expect(proxy).toMatch(/return 444/);
    expect(proxy).toMatch(/log_format jarvis_safe/);
    expect(proxy).toContain(
      "log_format jarvis_safe '$time_iso8601 $request_method $uri $status $body_bytes_sent $request_time';"
    );
    expect(proxy).not.toMatch(/\$request(?:\s|')|\$args\b|\$http_/);
    expect(proxy).toMatch(/ssl_protocols TLSv1\.2 TLSv1\.3/);
    expect(proxy).toMatch(/ssl_certificate \/run\/secrets\/seller_tls_certificate/);
    expect(proxy).toMatch(/ssl_certificate_key \/run\/secrets\/seller_tls_private_key/);
    expect(proxy).toMatch(/client_max_body_size 64k/);
    expect(proxy).toMatch(/limit_req_zone .*rate=30r\/m/);
    expect(proxy).toMatch(/limit_conn jarvis_conn_total 32/);
    expect(proxy).toMatch(/proxy_connect_timeout 2s/);
    expect(proxy).toMatch(/proxy_read_timeout 30s/);
    expect(proxy).toMatch(/location = \/v1\/edge-validation/);
    expect(proxy).toMatch(/location = \/mcp/);
    expect(proxy).toMatch(/location = \/\.well-known\/task-market\.json/);
    expect(proxy).toMatch(/location \/ \{\s*return 404;/s);
    expect(proxy.match(/proxy_pass http:\/\/172\.30\.0\.3:4021;/g)).toHaveLength(3);
    expect(proxy).not.toMatch(/proxy_pass\s+https?:\/\/(?:\$|127\.0\.0\.1|localhost)/);
  });

  it('documents the network boundary, quarantine, and a read-only compromise drill', async () => {
    const readme = await readFile(readmePath, 'utf8');

    for (const required of [
      /separate provider (?:account|project)/i,
      /no (?:private )?(?:network|route).*Jarvis/i,
      /RFC1918/i,
      /link-local/i,
      /169\.254\.169\.254/,
      /DNS/i,
      /TLS/i,
      /facilitator/i,
      /quarantine/i,
      /compromise drill/i,
      /read-only/i
    ]) {
      expect(readme).toMatch(required);
    }
    expect(readme).toMatch(/never.*(?:private key|signing key)/i);
    expect(readme).toMatch(/no (?:Docker socket|host mount)/i);
  });
});
