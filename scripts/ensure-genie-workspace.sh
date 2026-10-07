#!/usr/bin/env bash
# ensure-genie-workspace.sh — make the Genie workspace writable from *inside* the
# container, without ever detaching it from the host directory it names.
#
# Run this inside the console's container; it is what the boot unit and the daily
# timer run. The host half — the Incus disk device and the ownership on the host —
# is scripts/incus-workspace.sh, and this script points back to it for anything it
# cannot repair from here.
#
# Background: an unprivileged Incus container maps its root to a host ID (1000000
# for Incus's default map), so a host directory owned by host `root` (0) falls
# below that mapping and reads as `nobody` (65534) in here — unwritable, even by
# root. From in here, `root` *is* the host ID this container maps to, so a
# `chown root:root` is what repairs that: it writes the right host ID through the
# mount.
#
# Two things this deliberately no longer does, because both were worse than the
# problem:
#
#   * it does not unmount the workspace. Unmounting drops the container onto a
#     private directory in its own rootfs, which looks fixed and is not: the
#     console and the preview host stop sharing the tree, and previews fail
#     because the `cwd` the console computes does not exist where the process runs.
#   * it does not delete and recreate the directory. When the workspace *is* the
#     mount, that `rm -rf` would delete the projects — the one copy there is.
#
# A workspace that is not a mount is a thing to report, not to quietly swap out.
set -euo pipefail

WORKSPACE="${ONTRAK_GENIE_WORKSPACE:-/srv/genie-workspace}"
STATUS=0
CHANGED=0

# 1. It has to be the host's tree, mounted here. Anything else means the container
#    is looking at a directory of its own while the preview host looks elsewhere.
if mountpoint -q "$WORKSPACE" 2>/dev/null; then
  echo "  $WORKSPACE is mounted from the host"
else
  cat >&2 <<EOF
ensure-genie-workspace.sh: $WORKSPACE is not a mount in this container.
  This container is using a private directory, so the preview host cannot see the
  projects an agent edits and previews of them will not start. Fix it on the Incus
  host, then restart this container:

      bash scripts/incus-workspace.sh
EOF
  STATUS=1
fi

# 2. Ownership. Projects live one level down (`accounts/<id>`), so a shallow check
#    looks there too before deciding a full repair is needed — and the repair is a
#    chown, never a replacement.
misowned() {
  [ "$(stat -c '%U:%G' "$WORKSPACE")" != "root:root" ] && return 0
  if [ -d "$WORKSPACE/accounts" ]; then
    find "$WORKSPACE/accounts" -maxdepth 2 \! -user root -print -quit 2>/dev/null | grep -q . && return 0
  fi
  return 1
}

if misowned; then
  echo "  repairing ownership of $WORKSPACE (was $(stat -c '%U:%G' "$WORKSPACE"))"
  if chown -R root:root "$WORKSPACE" 2>/dev/null; then
    chmod 755 "$WORKSPACE" 2>/dev/null || true
    CHANGED=1
  else
    cat >&2 <<EOF
ensure-genie-workspace.sh: could not chown $WORKSPACE.
  Its owner is outside this container's ID mapping, which is exactly the state
  that makes writes fail with EACCES. Repair it on the Incus host:

      bash scripts/incus-workspace.sh
EOF
    STATUS=1
  fi
else
  echo "  $WORKSPACE is already root:root"
fi

# 3. Restart the app so its bind mount picks up a repair — but only when there was
#    one: this runs at boot and daily, and restarting a healthy console for nothing
#    is its own outage.
if [ "$CHANGED" = 1 ] && docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'ontrak-family-genie-app-1'; then
  echo "  restarting ontrak-family-genie-app-1 so it picks up the fix"
  docker restart ontrak-family-genie-app-1 >/dev/null
fi

[ "$STATUS" = 0 ] && echo "OK: $WORKSPACE is the host's tree and is writable" || echo "INCOMPLETE: see the messages above." >&2
exit "$STATUS"
