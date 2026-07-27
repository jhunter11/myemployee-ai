import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

interface RelayModule {
  FACILITATOR_RELAY_BIND_HOST: string;
  FACILITATOR_UPSTREAM_HOST: string;
  FACILITATOR_UPSTREAM_PORT: number;
  FACILITATOR_RELAY_MAX_CONNECTIONS: number;
  isPublicAddress(address: string, family: number): boolean;
  createFacilitatorRelay(options?: Record<string, unknown>): Server;
}

let relay: RelayModule;
const openServers: Server[] = [];
const openSockets: Socket[] = [];

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    resolve(process.cwd(), 'deploy/task-market/facilitator-relay.mjs')
  ).href;
  relay = (await import(moduleUrl)) as RelayModule;
});

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose) => {
          if (!server.listening) return resolveClose();
          server.close(() => resolveClose());
        })
    )
  );
});

describe('fixed x402 facilitator relay', () => {
  it('allows public IPs and blocks private, local, metadata, mapped, and documentation ranges', () => {
    for (const address of ['8.8.8.8', '1.1.1.1']) {
      expect(relay.isPublicAddress(address, 4)).toBe(true);
    }
    for (const address of [
      '0.0.0.1',
      '10.0.0.1',
      '100.64.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.0.1',
      '198.18.0.1',
      '203.0.113.1',
      '224.0.0.1'
    ]) {
      expect(relay.isPublicAddress(address, 4)).toBe(false);
    }
    expect(relay.isPublicAddress('2606:4700:4700::1111', 6)).toBe(true);
    for (const address of ['::', '::1', '::ffff:127.0.0.1', '2001:db8::1', 'fd00::1', 'fe80::1']) {
      expect(relay.isPublicAddress(address, 6)).toBe(false);
    }
    expect(relay.isPublicAddress('not-an-ip', 4)).toBe(false);
    expect(relay.isPublicAddress('8.8.8.8', 6)).toBe(false);
  });

  it('cannot be configured for a different destination or an unbounded connection ceiling', () => {
    expect(relay.FACILITATOR_RELAY_BIND_HOST).toBe('172.30.0.10');
    expect(relay.FACILITATOR_UPSTREAM_HOST).toBe('x402.org');
    expect(relay.FACILITATOR_UPSTREAM_PORT).toBe(443);
    expect(relay.FACILITATOR_RELAY_MAX_CONNECTIONS).toBe(64);
    expect(() => relay.createFacilitatorRelay({ upstreamHost: 'evil.test' })).toThrow(/allowlist/i);
    expect(() => relay.createFacilitatorRelay({ upstreamPort: 444 })).toThrow(/allowlist/i);
    expect(() => relay.createFacilitatorRelay({ maxConnections: 65 })).toThrow(/ceiling/i);
  });

  it('passes bounded bytes only to a public resolution of the fixed destination', async () => {
    const upstream = createServer((socket) => {
      socket.once('data', (data) => socket.end(data.toString('utf8').toUpperCase()));
    });
    openServers.push(upstream);
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const upstreamAddress = upstream.address();
    if (upstreamAddress === null || typeof upstreamAddress === 'string') throw new Error('no port');

    const connect = vi.fn(() =>
      createConnection({ host: '127.0.0.1', port: upstreamAddress.port })
    );
    const server = relay.createFacilitatorRelay({
      lookup: vi.fn().mockResolvedValue([{ address: '8.8.8.8', family: 4 }]),
      connect,
      dependencyTimeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      absoluteTimeoutMs: 2_000
    });
    openServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const relayAddress = server.address();
    if (relayAddress === null || typeof relayAddress === 'string') throw new Error('no port');

    const client = createConnection({ host: '127.0.0.1', port: relayAddress.port });
    openSockets.push(client);
    await once(client, 'connect');
    client.write('bounded');
    const [data] = (await once(client, 'data')) as [Buffer];

    expect(data.toString('utf8')).toBe('BOUNDED');
    expect(connect).toHaveBeenCalledWith({ host: '8.8.8.8', port: 443, family: 4 });
  });

  it('closes the client when DNS yields only a private address', async () => {
    const connect = vi.fn();
    const server = relay.createFacilitatorRelay({
      lookup: vi.fn().mockResolvedValue([{ address: '169.254.169.254', family: 4 }]),
      connect,
      dependencyTimeoutMs: 100,
      idleTimeoutMs: 100,
      absoluteTimeoutMs: 200
    });
    openServers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no port');

    const client = createConnection({ host: '127.0.0.1', port: address.port });
    openSockets.push(client);
    await once(client, 'close');

    expect(connect).not.toHaveBeenCalled();
  });
});
