import { lookup as systemLookup } from 'node:dns/promises';
import { BlockList, createConnection, createServer, isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

export const FACILITATOR_UPSTREAM_HOST = 'x402.org';
export const FACILITATOR_UPSTREAM_PORT = 443;
export const FACILITATOR_RELAY_BIND_HOST = '172.30.0.10';
export const FACILITATOR_RELAY_PORT = 443;
export const FACILITATOR_RELAY_MAX_CONNECTIONS = 64;

const DNS_AND_CONNECT_TIMEOUT_MS = 5_000;
const IDLE_TIMEOUT_MS = 10_000;
const ABSOLUTE_CONNECTION_TIMEOUT_MS = 30_000;

const blockedIpv4 = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4]
]) {
  blockedIpv4.addSubnet(network, prefix, 'ipv4');
}

const blockedIpv6 = new BlockList();
for (const [network, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['::ffff:0:0', 96],
  ['2001:db8::', 32],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8]
]) {
  blockedIpv6.addSubnet(network, prefix, 'ipv6');
}

export function isPublicAddress(address, family) {
  if (family === 4 && isIP(address) === 4) return !blockedIpv4.check(address, 'ipv4');
  if (family === 6 && isIP(address) === 6) return !blockedIpv6.check(address, 'ipv6');
  return false;
}

function withDeadline(promise, timeoutMs) {
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error('relay dependency timed out')), timeoutMs);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timeout));
}

export function createFacilitatorRelay(options = {}) {
  const lookup = options.lookup ?? systemLookup;
  const connect = options.connect ?? createConnection;
  const upstreamHost = options.upstreamHost ?? FACILITATOR_UPSTREAM_HOST;
  const upstreamPort = options.upstreamPort ?? FACILITATOR_UPSTREAM_PORT;
  const maxConnections = options.maxConnections ?? FACILITATOR_RELAY_MAX_CONNECTIONS;
  const dependencyTimeoutMs = options.dependencyTimeoutMs ?? DNS_AND_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const absoluteTimeoutMs = options.absoluteTimeoutMs ?? ABSOLUTE_CONNECTION_TIMEOUT_MS;
  let activeConnections = 0;

  if (upstreamHost !== FACILITATOR_UPSTREAM_HOST || upstreamPort !== FACILITATOR_UPSTREAM_PORT) {
    throw new Error('facilitator relay destination is not allowlisted');
  }
  if (!Number.isInteger(maxConnections) || maxConnections < 1 || maxConnections > 64) {
    throw new Error('facilitator relay connection ceiling is invalid');
  }

  const server = createServer({ pauseOnConnect: true }, (client) => {
    activeConnections += 1;
    let upstream;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeConnections -= 1;
    };
    const closeBoth = () => {
      client.destroy();
      upstream?.destroy();
    };

    client.once('close', release);
    if (activeConnections > maxConnections) {
      closeBoth();
      return;
    }
    client.setTimeout(idleTimeoutMs, closeBoth);
    const absoluteTimeout = setTimeout(closeBoth, absoluteTimeoutMs);
    client.once('close', () => clearTimeout(absoluteTimeout));

    void withDeadline(lookup(upstreamHost, { all: true, verbatim: true }), dependencyTimeoutMs)
      .then((addresses) => {
        const selected = addresses.find(({ address, family }) => isPublicAddress(address, family));
        if (selected === undefined) throw new Error('facilitator resolved to no public address');

        upstream = connect({ host: selected.address, port: upstreamPort, family: selected.family });
        upstream.setTimeout(idleTimeoutMs, closeBoth);
        upstream.once('error', closeBoth);
        client.once('error', closeBoth);
        const connectTimeout = setTimeout(closeBoth, dependencyTimeoutMs);
        upstream.once('connect', () => {
          clearTimeout(connectTimeout);
          client.resume();
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.once('close', () => {
          clearTimeout(connectTimeout);
          client.destroy();
        });
      })
      .catch(closeBoth);
  });
  server.maxConnections = maxConnections;
  return server;
}

export async function startFacilitatorRelay() {
  const server = createFacilitatorRelay();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(FACILITATOR_RELAY_PORT, FACILITATOR_RELAY_BIND_HOST, resolve);
  });
  process.stdout.write(
    `${JSON.stringify({ event: 'facilitator_relay_started', destination: 'x402.org:443' })}\n`
  );
  const shutdown = () => server.close(() => undefined);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  return server;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startFacilitatorRelay().catch(() => {
    process.stderr.write(
      `${JSON.stringify({ event: 'facilitator_relay_start_failed', message: 'Relay startup failed' })}\n`
    );
    process.exitCode = 1;
  });
}
