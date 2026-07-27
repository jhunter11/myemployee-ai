# Unattended operations workflow

Use this lane for launchd, caffeinate, watchdogs, disk guards, deployment, hosting, or remote access.

## Keep the runtime local and recoverable

- Bind Jarvis and its dashboard loopback-only. Reject wildcard and LAN binds before startup.
- Supervise the immutable release through launchd with `caffeinate -s`, `Umask 0077`, bounded logs,
  restart throttling, and restart only after nonzero exits.
- Separate liveness from readiness. Disk, database, and gateway failures block readiness; optional
  local model or container failures may degrade health without killing the control plane.
- Keep installers dry-run by default and produce exact planned paths and settings before mutation.

## Treat remote access as a security gate

Remote access remains disabled until a read-only audit proves the firewall and stealth mode are on,
guest shares are absent, a dedicated hardwired private peer exists, forwarding is off, legacy VNC
and Remote Management are off, and Jarvis still listens only on loopback. A failed audit is a final
no-go, not permission to weaken a check.

`caffeinate -s` prevents supported system sleep while on AC power; never promise that it overrides
unsupported lid-close behavior. Use launchd for recovery after any real sleep or restart.

## Verify

Test dry-run purity, secure file modes, immutable paths, hostile environment variables, wildcard
bind rejection, liveness/readiness failures, disk holds, log rotation, and remote audit no-go output.
