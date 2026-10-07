#!/usr/bin/env bash
# incus-workspace.sh — put the Genie workspace on every container that needs it,
# at the same path in each, and give it the ownership that makes it writable.
#
# Run this on the **Incus host**, not inside a container. It is the host half of
# the workspace; scripts/ensure-genie-workspace.sh is the container half, and what
# it cannot repair from the inside it prints as a pointer back to this script.
#
# ## Why a device and not a directory
#
# The console and the preview host are separate Incus containers, and a preview is
# the project the console is editing. Both have to see the *same* files at the
# *same* path: the console works out an absolute `cwd` and the preview host has to
# be able to run the command there. A docker volume is private to the daemon
# inside one container, so the shared tree lives on the host and each container
# gets it from an Incus disk device.
#
# Declaring the device is not the same as having it. A device added while a
# container is running has to be applied, and a container that comes up without it
# does not fail — it quietly serves a directory of its own, so previews fail as
# "nothing is listening" with both halves reporting themselves healthy. That is
# why this script checks the mount inside each container rather than trusting the
# config.
#
# ## Why the ownership is set from here
#
# An unprivileged container maps its root to a host ID (1000000 for Incus's
# default map). A host directory owned by host `root` (0) falls *below* that
# mapping, so inside the container it reads as `nobody` (65534) and cannot be
# written — not even by container root. The directory has to be owned by the host
# ID that maps to the container's root, so that base is read from the container
# rather than assumed. Get it wrong and nothing fails at boot: the symptom is an
# `EACCES` on the first file an agent tries to write, which reads as a bug in the
# agent.
#
# Idempotent. Re-running it is a no-op when the devices and the ownership are
# already right.
set -euo pipefail

WORKSPACE="${ONTRAK_GENIE_WORKSPACE:-/srv/genie-workspace}"
DEVICE="${ONTRAK_WORKSPACE_DEVICE:-genie-workspace}"
read -r -a CONTAINERS <<<"${ONTRAK_WORKSPACE_CONTAINERS:-ontrak genie-preview}"

STATUS=0
CHANGED=0

if ! command -v incus >/dev/null 2>&1; then
  echo "incus-workspace.sh: incus is not on PATH — run this on the Incus host." >&2
  exit 1
fi

echo "==> Genie workspace: $WORKSPACE"

# 1. The host directory itself. Owned by host root here on purpose: the ownership
#    that matters is applied in step 3, once each container's mapping is known.
if [ ! -d "$WORKSPACE" ]; then
  mkdir -p "$WORKSPACE"
  echo "  created $WORKSPACE"
  CHANGED=1
else
  echo "  $WORKSPACE exists"
fi

# 2. The device, on each container.
for container in "${CONTAINERS[@]}"; do
  if ! incus info "$container" >/dev/null 2>&1; then
    echo "  $container: no such container — skipped" >&2
    STATUS=1
    continue
  fi

  source="$(incus config device get "$container" "$DEVICE" source 2>/dev/null || true)"
  path="$(incus config device get "$container" "$DEVICE" path 2>/dev/null || true)"

  if [ "$source" = "$WORKSPACE" ] && [ "$path" = "$WORKSPACE" ]; then
    echo "  $container: device '$DEVICE' already declared"
  else
    [ -n "$source" ] && incus config device remove "$container" "$DEVICE" >/dev/null
    incus config device add "$container" "$DEVICE" disk \
      source="$WORKSPACE" path="$WORKSPACE" >/dev/null
    echo "  $container: device '$DEVICE' added ($WORKSPACE -> $WORKSPACE)"
    CHANGED=1
  fi

  # Declared is not mounted. Ask the container.
  if incus exec "$container" -- sh -c "grep -q ' $WORKSPACE ' /proc/self/mounts" 2>/dev/null; then
    echo "  $container: mounted"
  else
    echo "  $container: NOT mounted — restart it to apply the device" >&2
    STATUS=1
  fi
done

# 3. Ownership, from the mapping each container actually reports.
#
#    One directory has to satisfy both containers, so their bases have to agree;
#    if they ever do not, say so instead of silently favouring one.
bases=()
for container in "${CONTAINERS[@]}"; do
  incus info "$container" >/dev/null 2>&1 || continue

  base="$(incus exec "$container" -- sh -c 'awk "\$1 == 0 { print \$2; exit }" /proc/1/uid_map' 2>/dev/null || true)"
  if [ -z "$base" ]; then
    raw="$(incus config get "$container" raw.idmap 2>/dev/null || true)"
    base="$(printf '%s\n' "$raw" | awk '$1 == "both" || $1 == "uid" { if ($2 == 0) { print $3; exit } }')"
  fi
  if [ -z "$base" ]; then
    if [ "$(incus config get "$container" security.privileged 2>/dev/null || true)" = "true" ]; then
      base=0
    else
      # Incus's default unprivileged map. Only reachable for a stopped container
      # with no explicit idmap, which is why it is announced rather than assumed.
      base=1000000
      echo "  $container: not running — assuming the default unprivileged base ($base)" >&2
    fi
  fi

  echo "  $container: container root is host ID $base"
  bases+=("$base")
done

unique="$(printf '%s\n' "${bases[@]}" | sort -u | tr '\n' ' ')"
if [ "$(printf '%s\n' $unique | wc -l)" -gt 1 ]; then
  echo "incus-workspace.sh: containers disagree about the mapped root ($unique) — one directory cannot be owned for both." >&2
  exit 1
fi

owner="${bases[0]}"
chown -R "$owner:$owner" "$WORKSPACE"
echo "  ownership: $WORKSPACE -> $owner:$owner"

# 4. What each container makes of it, in the names it will use.
for container in "${CONTAINERS[@]}"; do
  incus info "$container" >/dev/null 2>&1 || continue
  seen="$(incus exec "$container" -- stat -c '%U:%G' "$WORKSPACE" 2>/dev/null || echo '?')"
  if [ "$seen" = "root:root" ]; then
    echo "  $container: sees root:root — writable"
  else
    echo "  $container: sees $seen, not root:root — the owner is outside its mapping" >&2
    STATUS=1
  fi
done

[ "$CHANGED" = 1 ] && echo "A device changed: restart the app containers so their bind mounts pick it up."
[ "$STATUS" = 0 ] && echo "OK: the workspace is shared and writable in every container." || echo "INCOMPLETE: see the messages above." >&2
exit "$STATUS"
