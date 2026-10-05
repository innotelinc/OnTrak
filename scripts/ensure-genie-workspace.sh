#!/usr/bin/env bash
# ensure-genie-workspace.sh — make /srv/genie-workspace permanently writable
#
# Run this on the Incus host whenever the workspace directory ownership is
# wrong (nobody:nogroup instead of root:root). Safe to re-run; it is idempotent.
#
# Background: the Incus container uses a user namespace that maps container
# UID 0 → host UID 1000000. Files owned by host UID 65534 (nobody) fall outside
# that mapping and become unmodifiable even by root inside the container. This
# script resets the directory so it is owned by a mapped UID.
set -euo pipefail

WORKSPACE="${ONTRAK_GENIE_WORKSPACE:-/srv/genie-workspace}"

# 1. If a device is mounted on the workspace path, unmount it so we can fix
#    the directory underneath. This handles the /dev/sda2 ext4 mount that was
#    previously the source of EACCES errors.
if mountpoint -q "$WORKSPACE" 2>/dev/null; then
  echo "Unmounting device at $WORKSPACE ..."
  umount -l "$WORKSPACE" || umount "$WORKSPACE"
fi

# 2. If the directory still has nobody:nogroup ownership, the device mount
#    may have left the directory in a state where chown is impossible inside
#    the container. Replace it.
if [ -d "$WORKSPACE" ] && [ "$(stat -c '%U:%G' "$WORKSPACE")" != "root:root" ]; then
  echo "Replacing nobody-owned directory at $WORKSPACE ..."
  # Try to fix in place first (works when the host has no user namespace).
  chown root:root "$WORKSPACE" 2>/dev/null || true
  if [ "$(stat -c '%U:%G' "$WORKSPACE")" != "root:root" ]; then
    rm -rf "$WORKSPACE"
    mkdir -p "$WORKSPACE"
  fi
fi

# 3. Create if missing.
if [ ! -d "$WORKSPACE" ]; then
  echo "Creating $WORKSPACE ..."
  mkdir -p "$WORKSPACE"
fi

# 4. Ensure correct ownership and permissions.
chown root:root "$WORKSPACE"
chmod 755 "$WORKSPACE"

echo "OK: $WORKSPACE is now owned by root:root (writable by container root)"

# 5. Restart the Docker container so the bind-mount picks up the new directory.
if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'ontrak-family-genie-app-1'; then
  echo "Restarting ontrak-family-genie-app-1 ..."
  docker restart ontrak-family-genie-app-1
fi
