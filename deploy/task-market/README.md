# Isolated x402 seller VPS

This profile runs the public `edge-validation-v1` seller plus a credential-free, fixed-destination
TCP relay for `x402.org:443`. It does not run the Jarvis gateway, dashboard, task executor,
Taskmarket worker, client automation, or a wallet signer. Isolation limits the blast radius of a
seller compromise; it cannot prove that every provider, hypervisor, kernel, DNS, registry, or
supply-chain attack is impossible.

## Security boundary

Provision this host in a **separate provider account or project** with separate billing and access
control when the provider supports it. There is no private network or route back to Jarvis. Do not
attach a VPC peer, VPN, Tailscale network, private service connection, or shared security group.
Jarvis stays loopback-only on its own machine and never accepts a callback from this VPS.

The preferred management path is a provider console or a short-lived provider API action initiated
from the control plane. Do not leave public SSH open and do not copy the management credential to
the VPS. The seller container never receives a private key, payment signing key, wallet seed,
provider token, GitHub credential, Jarvis database URL, client artifact, Docker socket, or host
mount. `TASK_MARKET_PAY_TO` is only a public receive address.

```text
Internet buyer -> host TLS proxy :443 -> 127.0.0.1:4021 -> seller container (internal network)
                                                               |
                                        raw TLS only -> fixed relay -> x402.org:443

Jarvis control plane          X no route, callback, shared network, or shared credential
Wallet/payment signer         X never installed on the seller VPS
```

The Compose profile publishes the seller port only on host loopback. The seller is attached only to
an internal Docker network: its compiled facilitator hostname maps to the relay's fixed internal
address, and it has no default Internet route. The relay accepts raw TCP from that internal network,
rejects private/link-local/reserved DNS results, and can connect only to the compiled
`x402.org:443` destination. It has no environment variables, secrets, volume, published port, HTTP
parser, wallet, or Jarvis credential. A separately managed host
TLS proxy terminates HTTPS, applies request/body/rate limits, and forwards only the documented HTTP
and Streamable HTTP MCP paths to `127.0.0.1:4021`. The proxy owns its TLS certificate material; it
does not receive a wallet key or Jarvis credential. Use DNS-based certificate validation if port 80
would otherwise need to remain open.

[`nginx.seller.conf`](./nginx.seller.conf) is the checked-in proxy baseline. Render only its public
hostname and certificate paths into a root-owned deployment copy, run `nginx -t` against that exact
copy, and verify the 64 KiB body, 32-connection, per-IP request, connect, send, and read ceilings
remain present. Do not give the proxy a Docker socket or mount the repository into it.

## Network policy

Apply both the provider firewall and a host forwarding policy. Docker-published traffic can bypass
some host firewall front ends, so verify the effective `DOCKER-USER`/nftables forwarding path rather
than relying on a dashboard toggle.

- Inbound: allow public TCP 443 to the TLS proxy. Deny TCP 4021 and all other public ingress. Use the
  provider console for administration.
- Outbound: default deny. The seller itself requires no general DNS or Internet egress. Permit the
  relay's established traffic, reviewed DNS path, and public TLS only to the Base Sepolia
  facilitator (`x402.org:443`); permit the host TLS proxy's exact certificate-authority and
  monitoring endpoints separately. Pull and patch images during a maintenance window.
- Deny RFC1918 ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), carrier-grade and provider
  internal ranges, IPv4 link-local (`169.254.0.0/16`), IPv6 unique-local (`fc00::/7`), and IPv6
  link-local (`fe80::/10`) from the container forwarding path. An exact DNS-resolver exception may
  be made only when required; it must not create a general link-local exception.
- Explicitly deny the common cloud metadata address `169.254.169.254` (and the provider's documented
  IPv6 metadata address) before every allow rule. Disable metadata service access at the provider
  layer too. Never place a metadata credential on this instance.
- Do not add a route to a Jarvis, client, office, home, CI, registry-control, or wallet network. The
  seller needs no private destination.

Domain IPs can change. Resolve approved destinations through a reviewed firewall or egress-proxy
update process, retain the previous ruleset for rollback, and fail closed if the allowlist cannot be
updated. Do not weaken the private/link-local denials to restore connectivity.

## Prepare and validate

Build `Dockerfile.task-market` in a trusted build environment, scan it, publish it, and set
`TASK_MARKET_SELLER_IMAGE` to the resulting immutable digest. Do not build from a Git checkout on the
seller VPS and do not give the VPS registry write authority.

Copy `task-market.testnet.env.example` to a deployment-only file, replace the image digest, public
Base Sepolia receive address, price, and public TLS origin, then keep the kill switch false. Before
the first start, create the external named volume and set its ownership. A fresh Docker volume is
root-owned; the explicit preparation prevents the non-root service from failing to open SQLite.
The one-time setup container has no network, a read-only image filesystem, and only `CAP_CHOWN`; it
is not part of the running Compose application.

```sh
set -a
. /etc/jarvis-task-market/testnet.env
set +a

docker pull "${TASK_MARKET_SELLER_IMAGE:?set a pinned seller image digest}"
docker volume create \
  --label dev.jarvis.zone=public-seller \
  jarvis_task_market_seller_settlements
docker run --rm --network none --read-only --user 0:0 \
  --cap-drop ALL --cap-add CHOWN \
  --mount type=volume,source=jarvis_task_market_seller_settlements,target=/var/lib/jarvis-task-market \
  --entrypoint /bin/chown "${TASK_MARKET_SELLER_IMAGE}" \
  1000:1000 /var/lib/jarvis-task-market
docker run --rm --network none --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges \
  --mount type=volume,source=jarvis_task_market_seller_settlements,target=/var/lib/jarvis-task-market \
  --entrypoint /usr/local/bin/node "${TASK_MARKET_SELLER_IMAGE}" \
  -e "require('node:fs').accessSync('/var/lib/jarvis-task-market',require('node:fs').constants.W_OK)"

docker compose \
  --env-file /etc/jarvis-task-market/testnet.env \
  -f deploy/task-market/compose.seller.json \
  config --quiet

docker compose \
  --env-file /etc/jarvis-task-market/testnet.env \
  -f deploy/task-market/compose.seller.json \
  up -d --pull always
```

The seller and relay run as numeric UID/GID `1000:1000`, drop all Linux capabilities, forbid privilege
escalation, use read-only root filesystems, and bound PIDs/CPU/memory/tmpfs/logs. No Docker socket
or host mount is present. There is no host network, host PID/IPC namespace, or privileged mode. Only
the seller has a persistent writable mount: the named volume at `/var/lib/jarvis-task-market`, which
contains untrusted facilitator-reported settlement evidence. Verify that UID/GID 1000 is the image's
unprivileged `node` user before promotion.

`/livez` is the container liveness probe. `/readyz` is a separate readiness signal and correctly
returns 503 while `TASK_MARKET_ACCEPTING_WORK=false`; this is the default kill switch, not a crash.
Keep it false until TLS, firewall, request limits, logs, backups, and a complete Base Sepolia payment
have been verified. This profile contains no mainnet variables or activation record.

## Artifact quarantine

There is no automatic artifact path from this seller to Jarvis. Reconcile revenue independently
from public-chain evidence. If an incident requires exporting the settlement database or logs, put
the copy in a quarantine location outside every Jarvis/client root, calculate its digest, scan it,
open it with read-only tooling, validate the expected schema and bounds, and require operator review.
Never import an executable, symlink, archive, raw request body, payment header, or unbounded log from
the VPS. Quarantine review is validation, not trust transfer.

## Read-only compromise drill

Run this compromise drill after first deployment and after firewall, image, or provider changes.
The commands below inspect or make bounded network probes; they do not stop, delete, rewrite, or
reconfigure the deployment.

```sh
# Render and inspect the effective configuration without starting anything.
docker compose --env-file /etc/jarvis-task-market/testnet.env \
  -f deploy/task-market/compose.seller.json config

# Inspect state, identity, namespaces, mounts, capabilities, and writable-layer drift.
docker compose --env-file /etc/jarvis-task-market/testnet.env \
  -f deploy/task-market/compose.seller.json ps
docker inspect jarvis-task-market-seller-seller-1 \
  --format '{{json .HostConfig}} {{json .Mounts}}'
docker top jarvis-task-market-seller-seller-1
docker diff jarvis-task-market-seller-seller-1

# Confirm only the TLS proxy is public and review the effective host/provider rules.
ss -lntup
nft list ruleset

# Confirm liveness is local, readiness remains disabled, and metadata is unreachable.
curl --fail --silent http://127.0.0.1:4021/livez >/dev/null
curl --silent --output /dev/null --write-out '%{http_code}\n' \
  http://127.0.0.1:4021/readyz
docker exec jarvis-task-market-seller-seller-1 node -e \
  "fetch('http://169.254.169.254',{signal:AbortSignal.timeout(2000)}).then(()=>{console.log('reachable');process.exit(1)}).catch(()=>console.log('blocked'))"

# Confirm required public DNS/TLS egress without printing response or credential data.
docker exec jarvis-task-market-seller-seller-1 node -e \
  "require('node:dns').promises.lookup('x402.org').then(()=>console.log('dns-ok')).catch(()=>process.exit(1))"
docker exec jarvis-task-market-seller-seller-1 node -e \
  "fetch('https://x402.org/facilitator',{method:'HEAD',signal:AbortSignal.timeout(5000)}).then(()=>console.log('tls-ok')).catch(()=>process.exit(1))"
```

Record evidence that:

- public listeners are limited to the TLS proxy and port 4021 is loopback-only;
- there is no provider peering, private route, public SSH listener, Docker socket, host mount, or
  reusable Jarvis/GitHub/wallet credential;
- the container is non-root with a read-only root, zero capabilities, bounded resources, and only
  the named settlement volume writable;
- DNS and required facilitator TLS work, while RFC1918, link-local, metadata, and every Jarvis/client
  destination are denied from the container forwarding path;
- the pinned running image digest matches the reviewed release; and
- any exported evidence remains quarantined and has not been imported into Jarvis.

Any unexpected route, listener, mount, credential, writable path, image digest, or successful
metadata/private-network probe is a deployment no-go. Leave the kill switch false, preserve the
read-only evidence, and rotate credentials from a clean control plane; do not investigate by
granting the compromised VPS broader access.
