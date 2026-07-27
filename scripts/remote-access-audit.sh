#!/bin/zsh -f
# Read-only hardwired remote-access and Jarvis exposure audit.
# This script changes no system, sharing, firewall, or application settings.
set -u

typeset -i audit_failures=0
audit_port="${JARVIS_AUDIT_PORT:-3000}"
audit_interface="${JARVIS_AUDIT_IF:-bridge0}"
audit_label="${JARVIS_AUDIT_LABEL:-com.aiagency.jarvis.gateway}"

audit_configuration_error() {
  printf 'remote audit configuration rejected: %s\n' "$1" >&2
  exit 64
}

[[ "$audit_port" == <-> ]] || audit_configuration_error "port must be numeric"
((audit_port >= 1 && audit_port <= 65535)) || \
  audit_configuration_error "port is outside the valid range"
[[ "$audit_interface" =~ ^[[:alnum:]][[:alnum:]_.-]{0,31}$ ]] || \
  audit_configuration_error "interface name is invalid"
[[ "$audit_label" =~ ^[[:alnum:]][[:alnum:].-]{0,127}$ ]] || \
  audit_configuration_error "launchd label is invalid"

audit_result() {
  if [[ "$1" == "PASS" ]]; then
    printf 'PASS  %s\n' "$2"
  else
    printf 'FAIL  %s\n' "$2"
    audit_failures=$((audit_failures + 1))
  fi
}

firewall_state=$(/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate 2>&1)
if [[ "$firewall_state" == *enabled* ]]; then
  audit_result PASS "application firewall enabled"
else
  audit_result FAIL "application firewall disabled"
fi

stealth_state=$(/usr/libexec/ApplicationFirewall/socketfilterfw --getstealthmode 2>&1)
if [[ "$stealth_state" == *enabled* || "$stealth_state" == *"on"* ]]; then
  audit_result PASS "stealth mode enabled"
else
  audit_result FAIL "stealth mode disabled"
fi

guest_share_count=$(/usr/sbin/sharing -l 2>/dev/null |
  /usr/bin/awk '/guest access:[[:space:]]*1/{count++} END{print count+0}')
if [[ "$guest_share_count" == "0" ]]; then
  audit_result PASS "no guest shares configured"
else
  audit_result FAIL "${guest_share_count} guest share(s) configured"
fi

for smb_port in 139 445; do
  if /usr/sbin/lsof -nP -iTCP:"$smb_port" -sTCP:LISTEN >/dev/null 2>&1; then
    audit_result FAIL "SMB is listening on TCP ${smb_port}"
  else
    audit_result PASS "SMB is not listening on TCP ${smb_port}"
  fi
done

interface_state=$(/sbin/ifconfig "$audit_interface" 2>/dev/null || true)
if [[ "$interface_state" == *"status: active"* ]]; then
  audit_result PASS "${audit_interface} active"
else
  audit_result FAIL "${audit_interface} inactive or missing"
fi

interface_ipv4=$(printf '%s\n' "$interface_state" |
  /usr/bin/awk '$1 == "inet" {print $2; exit}')
if [[ "$interface_ipv4" =~ ^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2[0-9]|3[01])\.) ]]; then
  audit_result PASS "hardwired address is private or link-local"
else
  audit_result FAIL "hardwired address is missing or not private"
fi

default_interface=$(/sbin/route -n get default 2>/dev/null |
  /usr/bin/awk '$1 == "interface:" {print $2; exit}')
if [[ -z "$default_interface" || "$default_interface" != "$audit_interface" ]]; then
  audit_result PASS "hardwired interface does not carry the default route"
else
  audit_result FAIL "hardwired interface carries the default route"
fi

peer_count=$(/usr/sbin/arp -an -i "$audit_interface" 2>/dev/null |
  /usr/bin/grep -v incomplete |
  /usr/bin/awk 'NF{count++} END{print count+0}')
if [[ "$peer_count" == "1" ]]; then
  audit_result PASS "exactly one wired peer"
else
  audit_result FAIL "wired peer count is ${peer_count}"
fi

if [[ "$(/usr/sbin/sysctl -n net.inet.ip.forwarding)" == "0" ]]; then
  audit_result PASS "IPv4 forwarding disabled"
else
  audit_result FAIL "IPv4 forwarding enabled"
fi

legacy_vnc=$(/usr/bin/defaults read \
  /Library/Preferences/com.apple.RemoteManagement \
  VNCLegacyConnectionsEnabled 2>/dev/null || printf '0')
if [[ "$legacy_vnc" != "1" ]]; then
  audit_result PASS "legacy VNC password disabled"
else
  audit_result FAIL "legacy VNC password enabled"
fi

if /bin/launchctl print system/com.apple.screensharing >/dev/null 2>&1; then
  audit_result PASS "Screen Sharing service loaded"
else
  audit_result FAIL "Screen Sharing service not loaded"
fi

if /usr/sbin/lsof -nP -iTCP:5900 -sTCP:LISTEN >/dev/null 2>&1; then
  audit_result PASS "Screen Sharing listening on TCP 5900"
else
  audit_result FAIL "Screen Sharing not listening on TCP 5900"
fi

if /usr/sbin/lsof -nP -iTCP:3283 -sTCP:LISTEN >/dev/null 2>&1; then
  audit_result FAIL "Remote Management is listening on TCP 3283"
else
  audit_result PASS "Remote Management is not listening on TCP 3283"
fi

jarvis_listeners=$(/usr/sbin/lsof -nP \
  -iTCP:"$audit_port" -sTCP:LISTEN -Fn 2>/dev/null |
  /usr/bin/sed -n 's/^n//p')
if [[ -n "$jarvis_listeners" ]] &&
  printf '%s\n' "$jarvis_listeners" |
    /usr/bin/awk '!/^127\.0\.0\.1:|^\[::1\]:/{bad=1} END{exit bad}'; then
  audit_result PASS "Jarvis listener is loopback-only"
else
  audit_result FAIL "Jarvis is missing or exposed beyond loopback on port ${audit_port}"
fi

readiness=$(/usr/bin/curl -fsS --connect-timeout 2 --max-time 8 \
  "http://127.0.0.1:${audit_port}/readyz" 2>/dev/null || true)
if printf '%s' "$readiness" | /usr/bin/jq -e '.status == "ready"' >/dev/null 2>&1; then
  audit_result PASS "Jarvis core readiness is ready"
else
  audit_result FAIL "Jarvis core readiness is unavailable or not ready"
fi

if /bin/launchctl print \
  "gui/$(/usr/bin/id -u)/${audit_label}" >/dev/null 2>&1; then
  audit_result PASS "Jarvis launchd job loaded"
else
  audit_result FAIL "Jarvis launchd job absent"
fi

if /usr/bin/fdesetup status 2>/dev/null | /usr/bin/grep -q 'FileVault is On'; then
  audit_result PASS "FileVault enabled"
else
  audit_result FAIL "FileVault disabled or status unavailable"
fi

if [[ "$audit_failures" -eq 0 ]]; then
  printf '\nGO: hardwired desktop-access prerequisites pass. Perform a manual peer/ACL test before enabling.\n'
else
  printf '\nNO-GO: %d prerequisite(s) failed. No remote-access setting was changed.\n' "$audit_failures"
fi

exit "$audit_failures"
