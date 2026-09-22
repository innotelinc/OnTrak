#!/usr/bin/env bash
# ============================================================================
# OnTrak — universal bootstrap.
#
#   bash scripts/setup.sh            # install whatever is missing, then set up
#   bash scripts/setup.sh --docker   # insist on the container path
#   bash scripts/setup.sh --python   # host-only: no Docker needed
#   bash scripts/setup.sh --check    # report readiness, change nothing
#   bash scripts/setup.sh --quiet    # what the Makefile calls
#
# OnTrak is meant to run anywhere — a lab server, a laptop, a mini-PC, a phone
# hotspot — so this script does not assume anything is installed. It finds the
# machine's package manager (apt, dnf, yum, apk, pacman, brew), installs the
# tools it is missing (Python + venv, make, openssl, curl, git, and Docker with
# its Compose plugin for the container path), builds the Python environment, and
# creates `.env` with generated local secrets.
#
# Two rules it holds to:
#
#   * it never overwrites a value that is already set — `scripts/secrets.sh` owns
#     that rule and this script only calls it;
#   * it never leaves a machine with *nothing*. If a tool cannot be installed
#     (no root, no package manager, an offline box) the failure is reported and
#     the script carries on with the path that does work, because the host portal
#     needs neither Docker nor Incus.
#
# The training machines themselves are a separate matter: they are Incus VMs and
# need a Linux host with /dev/kvm (`infra/bootstrap-host.sh`). Without one, the
# portal still serves every page — it just cannot provision a machine.
# ============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$ROOT"

MODE="auto"
QUIET=0

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --docker) MODE="docker" ;;
    --python) MODE="python" ;;
    --check | --dry-run) MODE="check" ;;
    --quiet | -q) QUIET=1 ;;
    -h | --help) usage; exit 0 ;;
    *)
      printf 'setup.sh: unknown option %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

# ── output ──────────────────────────────────────────────────────────────────
# Warnings go to stderr even in quiet mode: a machine that could not be
# prepared should say so, in an output the Makefile is streaming.
step() { [ "$QUIET" -eq 1 ] || printf '\033[36m==>\033[0m %s\n' "$*"; }
ok()   { [ "$QUIET" -eq 1 ] || printf '\033[32m  ✓\033[0m %s\n' "$*"; }
note() { [ "$QUIET" -eq 1 ] || printf '    %s\n' "$*"; }
warn() { printf '\033[33m  !\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31m  ✗\033[0m %s\n' "$*" >&2; exit 1; }

# ── privilege and package manager ───────────────────────────────────────────
# `SUDO=(env)` rather than an empty array when this is already root: an empty
# array expands to nothing under `set -u` on older bash (macOS ships 3.2), and
# `env <command>` runs the command unchanged, so the install lines stay one shape.
SUDO=(env)
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
  else
    SUDO=()
  fi
fi
can_install() { [ "$(id -u)" -eq 0 ] || [ "${#SUDO[@]}" -gt 0 ]; }

PM=""
detect_pm() {
  if command -v apt-get >/dev/null 2>&1; then PM="apt"
  elif command -v dnf >/dev/null 2>&1; then PM="dnf"
  elif command -v yum >/dev/null 2>&1; then PM="yum"
  elif command -v apk >/dev/null 2>&1; then PM="apk"
  elif command -v pacman >/dev/null 2>&1; then PM="pacman"
  elif command -v brew >/dev/null 2>&1; then PM="brew"
  fi
}

# The package names per manager. Best effort by design: where a name is wrong for
# an unusual release the install fails loudly here and the manual line is printed,
# which is a better outcome than a silent half-setup.
pkg_names() {
  case "$1:$PM" in
    curl:apt) echo "curl" ;; curl:dnf | curl:yum) echo "curl" ;;
    curl:apk) echo "curl" ;; curl:pacman) echo "curl" ;; curl:brew) echo "curl" ;;
    git:apt) echo "git" ;; git:dnf | git:yum) echo "git" ;;
    git:apk) echo "git" ;; git:pacman) echo "git" ;; git:brew) echo "git" ;;
    openssl:apt) echo "openssl" ;; openssl:dnf | openssl:yum) echo "openssl" ;;
    openssl:apk) echo "openssl" ;; openssl:pacman) echo "openssl" ;; openssl:brew) echo "openssl" ;;
    make:apt) echo "make" ;; make:dnf | make:yum) echo "make" ;;
    make:apk) echo "make" ;; make:pacman) echo "make" ;; make:brew) echo "make" ;;
    python:apt) echo "python3 python3-venv python3-pip" ;;
    python:dnf | python:yum) echo "python3 python3-pip" ;;
    python:apk) echo "python3 py3-pip python3-dev" ;;
    python:pacman) echo "python python-pip" ;; python:brew) echo "python" ;;
    docker:apt) echo "docker.io docker-compose-v2" ;;
    docker:dnf | docker:yum) echo "docker docker-compose-plugin" ;;
    docker:apk) echo "docker docker-cli-compose" ;;
    docker:pacman) echo "docker docker-compose" ;; docker:brew) echo "docker" ;;
    *) echo "" ;;
  esac
}

APT_UPDATED=0
pm_refresh() {
  [ "$PM" = "apt" ] || return 0
  [ "$APT_UPDATED" -eq 1 ] && return 0
  step "refreshing the package list (apt-get update)"
  "${SUDO[@]}" apt-get update -qq >/dev/null 2>&1 || warn "apt-get update failed; continuing with the existing index"
  APT_UPDATED=1
}

install_names() {
  # install_names <pkg> [<pkg>...]
  case "$PM" in
    apt) "${SUDO[@]}" apt-get install -y --no-install-recommends "$@" ;;
    dnf | yum) "${SUDO[@]}" "$PM" install -y "$@" ;;
    apk) "${SUDO[@]}" apk add --no-cache "$@" ;;
    pacman) "${SUDO[@]}" pacman -Sy --noconfirm "$@" ;;
    brew) brew install "$@" ;;
    *) return 1 ;;
  esac
}

have() { command -v "$1" >/dev/null 2>&1; }

# ensure <command> <logical name> [<manual hint>]
# Returns 0 when the command is available afterwards, 1 when it is not.
ensure() {
  local cmd="$1" logical="$2" hint="${3:-}"
  if have "$cmd"; then
    ok "$cmd"
    return 0
  fi
  if [ "$MODE" = "check" ]; then
    warn "$cmd is missing"
    return 1
  fi
  if [ -z "$PM" ] || ! can_install; then
    warn "$cmd is missing and cannot be installed here"
    [ -n "$hint" ] && note "$hint"
    return 1
  fi
  local names=() name
  while IFS= read -r name; do
    [ -n "$name" ] && names+=("$name")
  done < <(pkg_names "$logical")
  if [ "${#names[@]}" -eq 0 ]; then
    warn "$cmd is missing and there is no known $PM package for it"
    [ -n "$hint" ] && note "$hint"
    return 1
  fi

  step "installing ${logical} (${names[*]})"
  pm_refresh
  # A failed install is not fatal here: the caller decides whether the tool is
  # required for the path it is on. `|| true` keeps `set -e` out of the way.
  install_names "${names[@]}" >/dev/null 2>&1 || true
  if have "$cmd"; then
    ok "$cmd installed"
    return 0
  fi
  warn "could not install $cmd automatically"
  [ -n "$hint" ] && note "$hint"
  return 1
}

lan_address() {
  local addr=""
  if have ip; then
    addr="$(ip route get 1.1.1.1 2>/dev/null \
      | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}')"
  fi
  if [ -z "$addr" ] && have hostname; then
    addr="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  [ -n "$addr" ] && printf '%s' "$addr"
  return 0
}

# ── 1. the tools every path needs ───────────────────────────────────────────
detect_pm
step "OnTrak bootstrap in ${ROOT}"
if [ -n "$PM" ]; then
  ok "package manager: ${PM}"
else
  warn "no package manager found (apt, dnf, yum, apk, pacman, brew)"
  note "install anything missing by hand; this script will report what it needs"
fi

# openssl is what generates the local secrets, so it comes first.
ensure openssl openssl "debian: apt-get install openssl · macos: brew install openssl"
ensure curl curl "install curl, or fetch the repo another way"
ensure git git "install git, or download the checkout as a tarball"
# `make` drives the operator workflow. Installing it is what lets the very next
# instruction — `make run`, `make check` — work on a machine that had none.
ensure make make "debian: apt-get install make · macos: xcode-select --install"

# ── 2. Docker (the container path) ──────────────────────────────────────────
DOCKER_READY=0
COMPOSE_CMD=""
if [ "$MODE" != "python" ]; then
  if ensure docker docker "see docs/docker.md for a manual Docker install"; then
    if docker compose version >/dev/null 2>&1; then
      COMPOSE_CMD="docker compose"
      if docker info >/dev/null 2>&1; then
        DOCKER_READY=1
        ok "docker is running, with the compose plugin"
      else
        warn "docker is installed but the daemon is not answering"
        note "start it (systemctl start docker) or add your user to the docker group"
      fi
    else
      warn "docker is installed without the Compose plugin"
      note "install docker-compose-v2 (or docker-compose-plugin) and re-run"
    fi
  fi
fi
if [ "$MODE" = "docker" ] && [ "$DOCKER_READY" -ne 1 ]; then
  die "the container path was requested and Docker is not usable on this host"
fi

# ── 3. Python (the host path) ───────────────────────────────────────────────
PY_READY=0
PYTHON="${PYTHON:-python3}"
if [ "$MODE" != "docker" ]; then
  if ensure "$PYTHON" python "python 3.10 or newer, with venv"; then
    PY_READY=1
  fi
fi

if [ "$MODE" = "check" ]; then
  printf '\n'
  step "readiness"
  ok "docker: $([ "$DOCKER_READY" -eq 1 ] && echo "ready (${COMPOSE_CMD})" || echo "not usable")"
  ok "python: $([ "$PY_READY" -eq 1 ] && echo "ready (${PYTHON})" || echo "not usable")"
  step "nothing was changed (--check)"
  exit 0
fi

VENV=".venv"
VENV_PY="${VENV}/bin/python"

if [ "$PY_READY" -eq 1 ]; then
  if [ ! -d "$VENV" ]; then
    step "creating ${VENV}"
    if ! "$PYTHON" -m venv "$VENV" >/dev/null 2>&1; then
      # The common host failure: Python is there but python3-venv is not.
      warn "python3 -m venv failed — installing the venv module and retrying"
      ensure "$PYTHON" python "install python3-venv (debian/ubuntu) and re-run" || true
      "$PYTHON" -m venv "$VENV" >/dev/null 2>&1 \
        || die "could not create ${VENV}: install python3-venv (or python3-full) and re-run"
    fi
    ok "${VENV} created"
  fi

  # Go through `python -m pip`, never ${VENV}/bin/pip: a venv made with
  # --without-pip, or by a python3 -m venv whose host has python3-venv only half
  # installed, has no pip binary at all.
  if ! "$VENV_PY" -m pip --version >/dev/null 2>&1; then
    step "installing pip into ${VENV} (ensurepip)"
    "$VENV_PY" -m ensurepip --upgrade >/dev/null 2>&1 \
      || die "could not install pip into ${VENV}: install python3-venv (with pip) and re-run"
  fi

  step "installing Python dependencies"
  "$VENV_PY" -m pip install --quiet --upgrade pip
  "$VENV_PY" -m pip install --quiet -r requirements.txt
  "$VENV_PY" -m pip install --quiet -e .
  ok "Python environment ready (${VENV})"
fi

# ── 4. .env ─────────────────────────────────────────────────────────────────
# `scripts/secrets.sh` fills only blanks and never invents a value that is already
# there; this script is what guarantees the file exists at all.
step "creating .env with generated local secrets (existing values are kept)"
if [ "$QUIET" -eq 1 ]; then
  # The Makefile calls this on every fresh checkout: keep the run to itself. The
  # full, narrated version is `make setup`.
  bash scripts/secrets.sh >/dev/null
else
  bash scripts/secrets.sh
fi

# ── attribution guard hooks ─────────────────────────────────────────────────
if [ -d .githooks ] && have git && [ -d .git ]; then
  git config core.hooksPath .githooks
  ok "attribution guard hooks installed (.githooks)"
fi

if have pwsh; then
  ok "pwsh: guest scripts can be syntax-checked locally"
else
  note "pwsh not found (optional): scenario scripts are parsed at template build"
fi

# ── what to do next ─────────────────────────────────────────────────────────
# `make up` starts the TLS stack, so the URLs quoted below are the TLS port; the
# plain port is what `make up-plain` publishes (a host behind a TLS edge).
port="${ONTRAK_TLS_PORT:-8443}"
bind="${ONTRAK_BIND_ADDR:-0.0.0.0}"

printf '\n'
step "done"
if [ "$DOCKER_READY" -eq 1 ]; then
  note "make up     the full stack, TLS on one port: needs a local Incus host"
  [ -n "$COMPOSE_CMD" ] && note "docker compose up -d --build   the same, one command"
fi
if [ "$PY_READY" -eq 1 ]; then
  note "make serve        the real portal on this host"
fi
note "make run          let it decide: Docker if it is here, the host portal otherwise"

if [ "$bind" = "0.0.0.0" ]; then
  lan="$(lan_address || true)"
  if [ -n "$lan" ]; then
    note "on this machine   https://localhost:${port}"
    note "from other devices  https://${lan}:${port}   (make lan prints this again)"
  fi
fi
note "real training machines need a Linux host with KVM: sudo infra/bootstrap-host.sh"
