# Unattended loopback runtime

This package runs Jarvis as two user LaunchAgents on macOS:

- `com.aiagency.jarvis.gateway` supervises the gateway through `/usr/bin/caffeinate -s`.
- `com.aiagency.jarvis.watchdog` checks `/livez`, `/readyz`, disk capacity, and bounded log rotation every 60 seconds.

The gateway is fixed to `127.0.0.1`. The installer cannot publish it to a LAN, create a tunnel, enable Screen Sharing, or change firewall and file-sharing settings.

## Safety model

- Releases are copied outside the repository to `~/Library/Application Support/Jarvis/releases/<release-id>` and made read-only (`0555` directories, `0444` files, executable runtime scripts `0555`).
- Mutable database, client, workspace, and Markdown graph state live under a separate `state/` directory with `0700` permissions.
- LaunchAgents apply `Umask=0077`. A newly created SQLite database and logs therefore remain owner-only.
- `KeepAlive.SuccessfulExit=false` restarts crashes but allows an intentional clean stop. `ThrottleInterval=30` bounds a crash loop.
- The startup guard warns below 20% free disk and exits cleanly below 10%, preventing launchd from consuming the last space in a restart loop. The watchdog continues reporting the hold.
- Logs use bounded copy-and-truncate rotation at 10 MiB with five retained generations. No client payload is intentionally emitted by the watchdog.
- Readiness depends on gateway, database, and disk. Optional Ollama or Docker failures may degrade `/health`, but do not falsely mark the core gateway unready.

`caffeinate -s` requests prevention of system sleep only while the Mac is on AC power. It does not guarantee lid-closed operation. Do not use unsupported power-management overrides; use Apple-supported clamshell conditions and verify the LaunchAgents resume after wake.

## Build and inspect

Run the complete repository release gate, then create the compiled runtime:

```bash
npm test
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run memory:graph -- rebuild
git diff --check
```

Choose the exact release and Node executable. The first command is side-effect free:

```bash
JARVIS_RELEASE_ID="$(git rev-parse HEAD)"
JARVIS_NODE_BIN="$(command -v node)"

./scripts/runtime/install-launch-agent.sh \
  --dry-run \
  --release-id "$JARVIS_RELEASE_ID" \
  --node-bin "$JARVIS_NODE_BIN"
```

Review the JSON paths, then explicitly write the immutable release and two **unloaded** LaunchAgent files:

```bash
./scripts/runtime/install-launch-agent.sh \
  --install \
  --release-id "$JARVIS_RELEASE_ID" \
  --node-bin "$JARVIS_NODE_BIN"

plutil -lint \
  "$HOME/Library/LaunchAgents/com.aiagency.jarvis.gateway.plist" \
  "$HOME/Library/LaunchAgents/com.aiagency.jarvis.watchdog.plist"
```

The installer deliberately never calls `launchctl`. It also refuses to overwrite an existing immutable release or LaunchAgent definition.

## Explicit activation

Activation is a separate operator decision. Bootstrap both definitions together, then audit the live state:

```bash
JARVIS_GUI_DOMAIN="gui/$(id -u)"

launchctl bootstrap "$JARVIS_GUI_DOMAIN" \
  "$HOME/Library/LaunchAgents/com.aiagency.jarvis.gateway.plist" \
  "$HOME/Library/LaunchAgents/com.aiagency.jarvis.watchdog.plist"

./scripts/runtime/runtime-audit.sh
```

The runtime audit returns `GO` only when the plists are secure, the exact release is immutable, state permissions are private, launchd owns the gateway, `caffeinate -s` is present, only `127.0.0.1` is listening, core readiness succeeds, and disk is not critical. A disk warning is reported as `warn`; it should trigger cleanup before new storage-heavy work.

## Recoverable stop and rollback

Stop the watchdog first and then the gateway. This does not delete the release, database, graph, logs, or LaunchAgent files:

```bash
JARVIS_GUI_DOMAIN="gui/$(id -u)"

launchctl bootout "$JARVIS_GUI_DOMAIN/com.aiagency.jarvis.watchdog"
launchctl bootout "$JARVIS_GUI_DOMAIN/com.aiagency.jarvis.gateway"
```

Because the release and state remain intact, the same inspected definitions can be bootstrapped again. Preserve state before any later migration or release replacement.

## Remote access gate

Remote access decision: **NO-GO**.

This runtime package leaves all remote-access settings unchanged. The current host must not expose Jarvis through a proxy or tunnel: dashboard reads are intentionally loopback-local and mutation routes are not an internet authentication boundary.

Use the repository's read-only host audit for evidence:

```bash
./scripts/remote-access-audit.sh
```

Remote desktop stays disabled until that audit is `GO`, the owner explicitly authorizes activation, and all of these conditions are independently verified:

- firewall and stealth mode enabled;
- guest SMB shares removed;
- a dedicated hardwired private peer exists with no default route;
- legacy VNC and Remote Management remain disabled;
- access uses a dedicated standard macOS operator account;
- FileVault is enabled; and
- Jarvis continues listening only on `127.0.0.1` inside the Mac session.

There are intentionally no Screen Sharing, VNC, Remote Management, port-forwarding, or firewall-enablement commands in this runbook.
