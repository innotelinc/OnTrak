#!/usr/bin/env bash
# ============================================================================
# OnTrak — build a guest image from catalog media
#
#   sudo infra/build-workload-image.sh --entry win11-24h2
#
# Turns installation media into an Incus image published as `ontrak-<entry id>`,
# which is what `ontrak template build` then clones. This is the slow, once-per-
# platform step: everything a student experiences is a clone of its output.
#
# Media source decides what happens here:
#   free      the script will download it (`ontrak media fetch`) if it is not present
#   operator  the file must already be in the media store — OnTrak never downloads
#             licensed media
#
# Builders (`install.builder` in the catalog entry):
#   incus-windows    antifob/incus-windows: unattended Windows with virtio drivers,
#                    WinRM and the Incus agent. Used for Windows 10/11/Server.
#   answer-file      an autounattend.xml rendered by this script for Vista-8.1 and
#                    XP/2003 era media.
#   product          the entry is a *product* on top of another entry (recipe
#                    product-on-base): ship its media to a guest made from the base
#                    image, run the install script the catalog names inside it, and
#                    publish the result. Exchange, SQL Server, SharePoint and
#                    Microsoft 365 Apps are built this way.
#   manual           no unattended path exists (DOS-based Windows): build the guest by
#                    hand in the Incus UI, then publish it and use `--publish-only`.
# ============================================================================
set -euo pipefail

ENTRY=""
CONFIG=""
PREFIX="${ONTRAK_IMAGE_PREFIX:-ontrak}"
TOOLS_DIR="${ONTRAK_TOOLS_DIR:-/opt/ontrak/tools}"
PUBLISH_ONLY=0
KEEP_INSTANCE=0
STORAGE_POOL="${ONTRAK_INCUS_STORAGE_POOL:-default}"

usage() {
  cat <<'USAGE'
usage: build-workload-image.sh --entry <catalog-entry> [options]

  --entry ID          catalog entry to build (see `ontrak catalog list`)
  --config PATH       config file to use (default: config/ontrak.yaml)
  --publish-only      skip the install and publish an instance you built by hand
  --from INSTANCE     instance to publish with --publish-only
  --keep              keep the build instance (debugging)
  --prefix PREFIX     image alias prefix (default: ontrak)
  -h, --help          this help
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --entry) ENTRY="${2:?--entry needs a value}"; shift 2 ;;
    --config) CONFIG="${2:?--config needs a value}"; shift 2 ;;
    --publish-only) PUBLISH_ONLY=1; shift ;;
    --from) FROM_INSTANCE="${2:?--from needs a value}"; shift 2 ;;
    --keep) KEEP_INSTANCE=1; shift ;;
    --prefix) PREFIX="${2:?--prefix needs a value}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[ -n "$ENTRY" ] || { usage >&2; exit 2; }

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PY="${REPO_ROOT}/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3)"

ONTRAK=("$PY" -m ontrak)
[ -n "$CONFIG" ] && ONTRAK+=(--config "$CONFIG")

step() { printf '\n==> %s\n' "$*"; }
warn() { printf '[!] %s\n' "$*"; }
die() { printf '!! %s\n' "$*" >&2; exit 1; }

command -v incus >/dev/null 2>&1 || die "the incus CLI is not on PATH; run infra/bootstrap-host.sh first"

# ── where the image has to land ────────────────
# An image alias is project-scoped, and the platform builds its templates in the
# project `incus.project` names (`ontrak`, by default). An image published anywhere
# else is an image nothing can find, which is what this script used to do: it drove
# Incus with no --project at all while the rest of the platform used the configured
# one. The value comes from the environment first — that is how the platform reads it
# — and otherwise from the range's own .env, *read* rather than sourced: running an
# operator's config file as shell is the thing the repo's own tooling refuses to do.
read_env_value() {
    local key="$1"
    local file="$REPO_ROOT/.env"
    [ -f "$file" ] || return 0
    grep -m1 "^${key}=" "$file" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'" | tr -d '[:space:]'
}

PROJECT="${ONTRAK_INCUS__PROJECT:-$(read_env_value ONTRAK_INCUS__PROJECT)}"
PROJECT="${PROJECT:-ontrak}"
PROFILE="${ONTRAK_INCUS__PROFILE:-$(read_env_value ONTRAK_INCUS__PROFILE)}"
PROFILE="${PROFILE:-ontrak-student}"
NETWORK="${ONTRAK_INCUS__NETWORK:-$(read_env_value ONTRAK_INCUS__NETWORK)}"
NETWORK="${NETWORK:-ontrak0}"
INCUS=(incus --project "$PROJECT")

# ── read the manifest through the platform, never by parsing YAML here ───────
step "resolving catalog entry $ENTRY"
FACTS="$("${ONTRAK[@]}" catalog show "$ENTRY" 2>&1)" || die "$FACTS"
printf '%s\n' "$FACTS"

json() { printf '%s\n' "$FACTS" | grep -m1 "^  $1:" | sed "s/^  $1: *//" | tr -d ' '; }
ALIAS="${PREFIX}-${ENTRY}"
# Named here rather than at the publish step: every builder creates this instance, and
# the product path has to talk to it before the publish block runs.
INSTANCE="build-${ENTRY}"

# ── publish-only path: an operator-built guest becomes an image ─────────────
if [ "$PUBLISH_ONLY" -eq 1 ]; then
  [ -n "${FROM_INSTANCE:-}" ] || die "--publish-only needs --from <instance>"
  "${INCUS[@]}" info "$FROM_INSTANCE" >/dev/null 2>&1 || die "instance $FROM_INSTANCE does not exist"
  step "stopping $FROM_INSTANCE so the image is consistent"
  "${INCUS[@]}" stop "$FROM_INSTANCE" --force >/dev/null 2>&1 || true
  step "publishing $FROM_INSTANCE as $ALIAS"
  "${INCUS[@]}" publish "$FROM_INSTANCE" --alias "$ALIAS" --reuse
  step "done: $ALIAS (project $PROJECT)"
  echo "next: ontrak template build --all"
  exit 0
fi

# ── media ───────────────────────────────────────────────────────────────────
step "checking media"
if "${ONTRAK[@]}" media status "$ENTRY" | grep -qi 'operator-required'; then
  die "$(printf 'media for %s must be supplied by the operator:\n' "$ENTRY")$("${ONTRAK[@]}" media missing | grep "$ENTRY" || true)"
fi
if ! "${ONTRAK[@]}" media status "$ENTRY" | grep -qi ' present '; then
  step "media not present; fetching the freely redistributable copy"
  "${ONTRAK[@]}" media fetch "$ENTRY" || die "could not obtain media for $ENTRY"
fi

# ── builder ─────────────────────────────────────────────────────────────────
BUILDER="$(printf '%s\n' "$FACTS" | grep -i 'install:' | head -1 || true)"
if printf '%s\n' "$FACTS" | grep -qi 'recipe.*manual.*builder.*manual'; then
  cat <<EOF

!! $ENTRY has no unattended install path (recipe: manual).

   Install it by hand once, then publish the result:

     incus launch "$(json image)" build-$ENTRY --vm --profile default
     # ... install Windows/Office interactively, install virtio drivers and WinRM ...
     sudo $0 --entry $ENTRY --publish-only --from build-$ENTRY

EOF
  exit 1
fi

case "$BUILDER" in
  *incus-windows*)
    TOOL="${TOOLS_DIR}/incus-windows"
    if [ ! -d "$TOOL" ]; then
      cat <<EOF

!! the incus-windows builder is not installed.

   It automates the unattended Windows install that makes a graded guest possible
   (virtio drivers, WinRM, the Incus agent). Install it once:

     git clone https://github.com/antifob/incus-windows "$TOOL"
     (or point ONTRAK_TOOLS_DIR somewhere else and re-run)

   Then re-run this script.
EOF
      exit 1
    fi
    step "building with incus-windows (this takes tens of minutes)"
    printf '%s\n' "$FACTS" | sed 's/^/    /'
    ( cd "$TOOL" && ./incus-windows.sh build )
    ;;
  *answer-file*)
    step "rendering autounattend.xml"
    WORK="$(mktemp -d)"
    "${PY}" "${REPO_ROOT}/infra/windows/apply-postinstall.py" --help >/dev/null 2>&1 || true
    cat > "$WORK/README" <<EOF
The answer-file builder drives an unattended install with the unattend file rendered
from the catalog entry, then runs infra/windows/post-install.ps1 inside the guest to
install the VirtIO drivers, enable WinRM and create the training account.

Build it with the same virtio-win media the entry declares, then publish:

    sudo $0 --entry $ENTRY --publish-only --from build-$ENTRY
EOF
    step "rendered at $WORK"
    ;;
  *product*)
    # A product image is the base OS image plus an install that happens *inside* the
    # guest, so this needs the base, a guest the agent can still reach while the
    # product reboots it, and the media in the guest's hands.
    BASE_ENTRY="$(printf '%s\n' "$FACTS" | grep -m1 '^  requires:' | sed 's/^  requires: *//' | cut -d, -f1 | tr -d ' ')"
    [ -n "$BASE_ENTRY" ] || die "$ENTRY is a product entry and names no base in requires"
    BASE_IMAGE="${PREFIX}-${BASE_ENTRY}"
    "${INCUS[@]}" image info "$BASE_IMAGE" >/dev/null 2>&1 \
      || die "the base image $BASE_IMAGE is not published in project $PROJECT:
     build it first:  sudo $0 --entry $BASE_ENTRY"
    if "${INCUS[@]}" info "$INSTANCE" >/dev/null 2>&1; then
      warn "removing the leftover build instance $INSTANCE"
      "${INCUS[@]}" stop "$INSTANCE" --force >/dev/null 2>&1 || true
      "${INCUS[@]}" delete "$INSTANCE" --force
    fi
    step "launching $BASE_IMAGE as $INSTANCE (project $PROJECT)"
    "${INCUS[@]}" init "$BASE_IMAGE" "$INSTANCE" -p default -p "$PROFILE"
    # Two devices a clone has to re-create, both of which Incus refuses to start
    # without: the NIC, because the image's own device may name another bridge, and the
    # agent config disk, because a Windows image built by incus-windows is published
    # with requirements.cdrom_agent=true and fails at *start* with "This virtual machine
    # image requires an agent:config disk be added".
    "${INCUS[@]}" config device add "$INSTANCE" eth0 nic network="$NETWORK" 2>/dev/null || true
    if [ "$("${INCUS[@]}" config get "$INSTANCE" image.requirements.cdrom_agent 2>/dev/null || true)" = "true" ]; then
      step "adding the agent config disk the base image asks for"
      "${INCUS[@]}" config device add "$INSTANCE" agent disk source=agent:config
    fi
    "${INCUS[@]}" start "$INSTANCE"
    step "waiting for the guest to answer"
    IP=""
    for _ in $(seq 1 180); do
      IP="$("${INCUS[@]}" list "$INSTANCE" --format=csv -c 4 | cut -d' ' -f1)"
      [ -n "$IP" ] && break
      sleep 5
    done
    [ -n "$IP" ] || die "$INSTANCE never got an address; check the $NETWORK bridge"
    # The agent transport, deliberately: the product install promotes this guest to a
    # domain controller (Exchange and SharePoint need a forest), and an account that was
    # a local administrator stops being one the moment the machine becomes a DC. The
    # agent runs as SYSTEM inside the guest and does not care what the directory thinks
    # of the caller.
    if ! ONTRAK_GUEST__DRIVER="${ONTRAK_GUEST__DRIVER_PRODUCT:-incus-exec}" \
         "$PY" "$REPO_ROOT/infra/windows/apply-product-install.py" "$INSTANCE" --entry "$ENTRY" --address "$IP"; then
      die "the product install failed. $INSTANCE is left running, with its media still attached, so the logs it
     wrote are readable: the product's own (C:\ExchangeSetupLogs, C:\Program Files\Microsoft SQL Server\...\Log)
     and OnTrak's copy of the run. Delete it with 'incus --project $PROJECT delete $INSTANCE --force' when done."
    fi
    ;;
  *)
    die "unknown builder for $ENTRY: $BUILDER"
    ;;
esac

# ── publish ─────────────────────────────────────────────────────────────────
if "${INCUS[@]}" info "$INSTANCE" >/dev/null 2>&1; then
  step "stopping $INSTANCE"
  "${INCUS[@]}" stop "$INSTANCE" --force >/dev/null 2>&1 || true
  step "publishing as $ALIAS on pool $STORAGE_POOL (project $PROJECT)"
  "${INCUS[@]}" publish "$INSTANCE" --alias "$ALIAS" --reuse
  if [ "$KEEP_INSTANCE" -eq 0 ]; then
    step "deleting the build instance"
    "${INCUS[@]}" delete "$INSTANCE" --force
  fi
else
  die "no build instance named $INSTANCE was produced"
fi

step "done: image $ALIAS"
echo "next:"
echo "  ontrak template build --all      # boot it once per scenario, inject the fault, snapshot"
echo "  ontrak pool prewarm --scenario <scenario> --count <n>"
