# Reaching the Dashboard From Another Machine

The control room is **loopback-only by design, and has no authentication of its own.**
That is not an oversight to be patched around — it is the entire security model, and it is
enforced at two independent layers:

| Layer                                                     | Behaviour                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------- |
| `isLoopbackHost` in `src/gateway/server.ts`               | The gateway **throws** if asked to bind a non-loopback host      |
| `requireLoopbackDashboardHost` in `src/dashboard/routes.ts` | Rejects any request whose `Host` header is not exact loopback  |

Because there is no login, binding this to `0.0.0.0` would put an unauthenticated control
plane on your network. Anything on that network could approve action proposals, drive model
runs, and read tenant-safe summaries. Do not do it.

## Use an SSH tunnel instead

Forward the port over SSH from the machine you want to browse from. Jarvis keeps binding to
loopback, both guards stay intact, and the traffic is encrypted in transit.

Run this **on your desktop**, replacing the host with this Mac's name or LAN address:

```bash
ssh -N -L 3000:localhost:3000 <user>@<this-mac>.local
```

Then open <http://localhost:3000/dashboard> on the desktop. From the gateway's perspective the
request arrives from loopback, so no guard has to be relaxed.

Notes:

- `-N` opens no shell — it only forwards the port. Add `-f` to background it.
- Keep the local port at `3000` (or whatever `PORT` the gateway uses). The `Host` header the
  browser sends is `localhost:<local port>`, and that is what the guard inspects.
- Remote Login must be enabled on this Mac: System Settings → General → Sharing → Remote Login.
- If the gateway picked a different port because 3000 was busy, forward that port instead.

For a persistent setup across networks, a private mesh VPN (Tailscale, WireGuard) gives the
same property: the dashboard still answers on loopback, and only your own devices can reach the
host at all.

## What was deliberately not built

An env-gated LAN bind with a shared-secret token was considered and rejected on 2026-07-24.
It would have meant a permanently weaker default and a new auth path to get right, to solve a
problem that port forwarding already solves with no code and no exposure. Revisit only if the
dashboard gains real authentication.

## Demo data for local development

The run-supervision and P&L surfaces are empty until real automations execute. To populate them
for development or a visual check:

```bash
npm run dev:seed-dashboard
```

This writes `demo_`-prefixed rows into the scratch database at
`.audit-tmp/jarvis-audit.sqlite` only. It exercises all three supervisor derivations and every
cost basis, including a subscription-only sleeve that must render as *uncovered* rather than as
$0. Never point it at a real operator database.
