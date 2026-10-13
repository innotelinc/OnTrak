#!/usr/bin/env bash
#
# Import scenario templates published by ``infra/publish-templates.sh``, so this
# host can run scenarios it cannot build.
#
#   infra/import-templates.sh                        # every tag in the repository
#   infra/import-templates.sh tpl-net-dns-failure     # named templates
#
# Building a template means booting the platform once per scenario. Where a Windows
# guest has to be emulated (a host whose KVM cannot virtualise SMM — see
# docs/operations.md, "Building the golden image on a nested host") that is hours,
# so the templates are built on the host that can, published, and restored here.
#
# What is restored is the whole instance, as ``incus export`` wrote it: the disk,
# the instance's own devices and config, and the profile references. Two things are
# re-done here rather than shipped, because they are facts about *this* host:
#
#   1. the ``clean`` snapshot. The published backup is ``--instance-only``, so the
#      instance arrives carrying the faulted disk and no snapshot; taking the
#      snapshot again is what makes it a template `ontrak` will use.
#   2. the QEMU accelerator. A Windows guest built on a KVM host has no accelerator
#      override in its config, and its clones would ask for KVM — which a host that
#      needed the import in the first place cannot give. ``infra/qemu-accel.sh``
#      points it at the accelerator this host actually has.
#
# A failure is reported per template and the run continues, because a registry answers
# a multi-gigabyte pull with a transient HTTP/2 error now and then: one template that
# could not be restored is worth a line and a non-zero exit, not the abandonment of
# every template behind it.
#
# Environment:
#   ONTRAK_TEMPLATE_REPOSITORY  source repository
#                               (default: ghcr.io/innotelinc/ontrak-template)
#   ONTRAK_TEMPLATE_TAG_PREFIX  tag prefix used at publish time (default: empty)
#   ONTRAK_INCUS_PROJECT        Incus project to restore into (default: ontrak)
#   ONTRAK_TEMPLATE_POOL        pool to restore into. Default: the pool this range is
#                               configured to use, because the restore has to reach a
#                               snapshot — see "which pool" below.
#   ONTRAK_TEMPLATE_SNAPSHOT    snapshot to take after the restore (default: clean)
#   ONTRAK_TEMPLATE_WORKDIR     where the backups are pulled to. Default: a directory
#                               on the project's own storage pool.
#   ONTRAK_TEMPLATE_FORCE       set to 1 to replace a template that is already here
#   ONTRAK_GOLDEN_TOKEN         registry token to log in with, as for the golden
#                               image. Default: `gh auth token`.
#   ONTRAK_GOLDEN_USER          username for that token. Default: `gh api user`.
#   ONTRAK_ORAS                 oras binary to use (default: `oras` on PATH)

set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPOSITORY="${ONTRAK_TEMPLATE_REPOSITORY:-ghcr.io/innotelinc/ontrak-template}"
TAG_PREFIX="${ONTRAK_TEMPLATE_TAG_PREFIX:-}"
PROJECT="${ONTRAK_INCUS_PROJECT:-ontrak}"
SNAPSHOT="${ONTRAK_TEMPLATE_SNAPSHOT:-clean}"
ORAS="${ONTRAK_ORAS:-oras}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

command -v incus >/dev/null || die "incus not found; run infra/bootstrap-host.sh first"
command -v "$ORAS" >/dev/null || die "oras not found — set ONTRAK_ORAS to its path, or install it (https://oras.land)"

# See the twin comment in infra/publish-templates.sh: a relative ONTRAK_ORAS is
# pinned before this script changes directory.
if [[ "$ORAS" == */* ]]; then
  ORAS="$(cd "$(dirname "$ORAS")" && pwd)/$(basename "$ORAS")"
fi

# ----------------------------------------------------------------- which ones ---
# With no arguments, every tag in the repository is restored. `oras repo tags` is how
# a fresh host learns what there is to pull, rather than an operator copying a list.
log_in() {
  TOKEN="${ONTRAK_GOLDEN_TOKEN:-}"
  USERNAME="${ONTRAK_GOLDEN_USER:-}"
  if command -v gh >/dev/null 2>&1; then
    [[ -z "$TOKEN" ]] && TOKEN="$(gh auth token 2>/dev/null || true)"
    [[ -z "$USERNAME" ]] && USERNAME="$(gh api user --jq .login 2>/dev/null || true)"
  fi
  if [[ -n "$TOKEN" ]]; then
    [[ -n "$USERNAME" ]] || USERNAME="token"
    registry="${REPOSITORY%%/*}"
    log "authenticating to $registry as $USERNAME"
    printf '%s' "$TOKEN" | "$ORAS" login "$registry" -u "$USERNAME" --password-stdin >/dev/null \
      || die "oras login to $registry failed — check the token's read:packages scope"
  fi
}

if [[ $# -gt 0 ]]; then
  NAMES=("$@")
else
  log_in
  mapfile -t TAGS < <("$ORAS" repo tags "$REPOSITORY" 2>/dev/null || true)
  [[ ${#TAGS[@]} -gt 0 ]] || die "no tags in $REPOSITORY (or it is unreachable). Pull one by name to get a clearer error."
  NAMES=()
  for tag in "${TAGS[@]}"; do
    NAMES+=("${tag#"$TAG_PREFIX"}")
  done
fi

# ------------------------------------------------------------------- workdir ----
WORKDIR="${ONTRAK_TEMPLATE_WORKDIR:-}"
if [[ -z "$WORKDIR" ]]; then
  pool="$(incus --project "$PROJECT" profile device get default root pool 2>/dev/null || true)"
  if [[ -n "$pool" && -d "/var/lib/incus/storage-pools/$pool" ]]; then
    WORKDIR="/var/lib/incus/storage-pools/$pool/ontrak-template-import"
  else
    WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/ontrak-template-import.XXXXXX")"
  fi
fi
mkdir -p "$WORKDIR"

# --------------------------------------------------------------- which pool ----
# A template has to be restored onto a pool that can snapshot it. On the ``dir``
# driver Incus takes a **virtual machine's** snapshot by copying the guest's disk with
# ``dd --direct``, and a filesystem that refuses ``O_DIRECT`` reads refuses that
# outright: the import succeeds, the snapshot dies, and what is left behind is an
# unsnapshotted instance named like a template — a Windows scenario no student can
# start, with nothing in its name that says so. So the restore names the pool, and
# because a clone stays on its source's pool it is also what puts every student's own
# machine somewhere its snapshots are native. Read with the same precedence as
# ``ontrak/config.py``: the environment, then ``config/local.yaml``, then the shipped
# ``config/ontrak.yaml``.
configured_pool() {
  local value file
  if [[ -n "${ONTRAK_INCUS__STORAGE_POOL:-}" ]]; then
    printf '%s' "$ONTRAK_INCUS__STORAGE_POOL"
    return
  fi
  for file in "$PROJECT_ROOT/config/local.yaml" "$PROJECT_ROOT/config/ontrak.yaml"; do
    [[ -f "$file" ]] || continue
    value="$(sed -n 's/^[[:space:]]*storage_pool:[[:space:]]*//p' "$file" | head -1 \
      | sed 's/#.*//' | tr -d '\042\047[:space:]')"
    if [[ -n "$value" ]]; then
      printf '%s' "$value"
      return
    fi
  done
}

POOL="${ONTRAK_TEMPLATE_POOL:-$(configured_pool)}"
POOL_DRIVER=""
if [[ -n "$POOL" ]]; then
  POOL_DRIVER="$(incus storage list --format csv 2>/dev/null | awk -F, -v p="$POOL" '$1==p {print $2}')"
else
  warn "no pool is configured for this range: restoring into whatever pool each backup was taken from"
fi

log_in

# ------------------------------------------------------------------- restore ----
restored=0
skipped=0
failed=0
for name in "${NAMES[@]}"; do
  tag="${TAG_PREFIX}${name}"
  tarball="$WORKDIR/$name.tar.gz"

  if incus --project "$PROJECT" info "$name" >/dev/null 2>&1; then
    if [[ "${ONTRAK_TEMPLATE_FORCE:-}" =~ ^(1|true|yes|on)$ ]]; then
      warn "$name is already here — replacing it (ONTRAK_TEMPLATE_FORCE)"
      incus --project "$PROJECT" stop "$name" --force >/dev/null 2>&1 || true
      incus --project "$PROJECT" delete "$name" --force >/dev/null 2>&1 || true
    else
      warn "$name is already here — skipping (set ONTRAK_TEMPLATE_FORCE=1 to replace it)"
      skipped=$((skipped + 1))
      continue
    fi
  fi

  log "$name: pulling $REPOSITORY:$tag"
  rm -f "$tarball"
  # One template's failure is that template's, not the run's. A registry answers a
  # large artifact pull with a transient HTTP/2 error now and then, and aborting here
  # used to abandon every template after it — having already deleted the ones named
  # with ONTRAK_TEMPLATE_FORCE, so the run that failed to replace a template left the
  # range with one fewer than it started with.
  if ! ( cd "$WORKDIR" && "$ORAS" pull "$REPOSITORY:$tag" >/dev/null ); then
    warn "$name: pull failed — left out of this run; the others still restore"
    failed=$((failed + 1))
    continue
  fi

  log "$name: importing (this is the whole disk: expect minutes, not seconds)"
  import_args=("import" "$tarball" "$name")
  [[ -n "$POOL" ]] && import_args+=(-s "$POOL")
  if ! incus --project "$PROJECT" "${import_args[@]}"; then
    warn "$name: import failed — left out of this run; the others still restore"
    rm -f "$tarball"
    failed=$((failed + 1))
    continue
  fi

  # The accelerator is a host fact. Re-asked here, on the instance, because a guest
  # built where KVM works carries no override and its clones would ask for KVM on a
  # host that cannot give it. Virtual machines only: raw.qemu.conf is a VM setting
  # and Incus rejects it on a container.
  kind="$(incus --project "$PROJECT" list "$name" --format=csv -c t 2>/dev/null | head -1)"
  if [[ "$kind" == "virtual-machine" ]]; then
    "$PROJECT_ROOT/infra/qemu-accel.sh" --apply "$name" "$PROJECT" >/dev/null
  fi

  # Named before it happens rather than left as a `dd` error two minutes from now.
  if [[ "$kind" == "virtual-machine" && "$POOL_DRIVER" == "dir" ]]; then
    warn "$name is a VM on pool '$POOL', which uses dir: the '$SNAPSHOT' snapshot is a"
    warn "  full copy of the guest's disk made with dd --direct, and a filesystem that"
    warn "  refuses O_DIRECT reads refuses that. Restore onto a ZFS or btrfs pool."
  fi

  if ! incus --project "$PROJECT" snapshot create "$name" "$SNAPSHOT" >/dev/null; then
    # An instance without its snapshot is not a template: `ontrak` refuses it, and it
    # is left here rather than deleted so the disk it holds can be inspected — the
    # usual cause is a pool whose driver cannot snapshot a VM.
    warn "$name: imported, but its '$SNAPSHOT' snapshot failed, so it is not a"
    warn "  template yet. Fix the pool, then run this again with ONTRAK_TEMPLATE_FORCE=1."
    failed=$((failed + 1))
    continue
  fi
  rm -f "$tarball"
  log "$name: restored ($kind, snapshot '$SNAPSHOT')"
  restored=$((restored + 1))
done

if [[ $failed -gt 0 ]]; then
  log "restored $restored template(s), skipped $skipped, failed $failed"
else
  log "restored $restored template(s), skipped $skipped"
fi

cat <<EOF
Next
  * Confirm the range can serve them:  .venv/bin/ontrak doctor
  * See what it has to work with:     make check
EOF

# Non-zero when a template was asked for and is not here: a run that restored three of
# five has not done its job, however clearly it said so line by line.
[[ $failed -eq 0 ]] || exit 1
