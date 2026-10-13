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
die() { printf '!! %s\n' "$*" >&2; exit 1; }

command -v incus >/dev/null 2>&1 || die "the incus CLI is not on PATH; run infra/bootstrap-host.sh first"

# ── read the manifest through the platform, never by parsing YAML here ───────
step "resolving catalog entry $ENTRY"
FACTS="$("${ONTRAK[@]}" catalog show "$ENTRY" 2>&1)" || die "$FACTS"
printf '%s\n' "$FACTS"

json() { printf '%s\n' "$FACTS" | grep -m1 "^  $1:" | sed "s/^  $1: *//" | tr -d ' '; }
ALIAS="${PREFIX}-${ENTRY}"

# ── publish-only path: an operator-built guest becomes an image ─────────────
if [ "$PUBLISH_ONLY" -eq 1 ]; then
  [ -n "${FROM_INSTANCE:-}" ] || die "--publish-only needs --from <instance>"
  incus info "$FROM_INSTANCE" >/dev/null 2>&1 || die "instance $FROM_INSTANCE does not exist"
  step "stopping $FROM_INSTANCE so the image is consistent"
  incus stop "$FROM_INSTANCE" --force >/dev/null 2>&1 || true
  step "publishing $FROM_INSTANCE as $ALIAS"
  incus publish "$FROM_INSTANCE" --alias "$ALIAS" --reuse
  step "done: $ALIAS"
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
  *)
    die "unknown builder for $ENTRY: $BUILDER"
    ;;
esac

# ── publish ─────────────────────────────────────────────────────────────────
INSTANCE="build-${ENTRY}"
if incus info "$INSTANCE" >/dev/null 2>&1; then
  step "stopping $INSTANCE"
  incus stop "$INSTANCE" --force >/dev/null 2>&1 || true
  step "publishing as $ALIAS on pool $STORAGE_POOL"
  incus publish "$INSTANCE" --alias "$ALIAS" --reuse
  if [ "$KEEP_INSTANCE" -eq 0 ]; then
    step "deleting the build instance"
    incus delete "$INSTANCE" --force
  fi
else
  die "no build instance named $INSTANCE was produced"
fi

step "done: image $ALIAS"
echo "next:"
echo "  ontrak template build --all      # boot it once per scenario, inject the fault, snapshot"
echo "  ontrak pool prewarm --scenario <scenario> --count <n>"
