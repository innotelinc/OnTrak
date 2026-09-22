# ==========================================================================
# OnTrak — operator workflow
# Usage: make <target>   (see `make help`)
#
# `make` needs nothing installed first. Every target that uses Python depends on
# the venv stamp below, so `make check` on a fresh clone builds the venv and
# installs the dependencies itself; scripts/setup.sh also installs the system
# tools it needs (python, make, openssl, and Docker for the container path) when
# they are missing. `make setup` is still there, but it is no longer a step you
# have to know about before anything works.
# ==========================================================================

.DEFAULT_GOAL := help
SHELL := /bin/bash
VENV := .venv
PY := $(VENV)/bin/python
STAMP := $(VENV)/.ontrak-ready
BOOTSTRAP := scripts/setup.sh

# The venv, built once and rebuilt when the manifests change. Order-only
# prerequisites (see `| $(STAMP)` below) make this run before a target without
# forcing the target to rebuild whenever it does.
$(STAMP): requirements.txt pyproject.toml $(BOOTSTRAP)
	@bash $(BOOTSTRAP) --quiet --python
	@touch $(STAMP)

COMPOSE := docker compose
IMAGE := $(if $(ONTRAK_IMAGE),$(ONTRAK_IMAGE),ontrak:local)
# The base stack is the single-host lab, and `lab-setup` makes it work on a
# first run: secrets, then Incus on the host. `docker-compose.remote.yml` is for
# the deployments that have no host hypervisor to prepare (a remote cluster).
# See docs/docker.md.
REMOTE_OVERLAY := -f docker-compose.yml -f docker-compose.remote.yml
TLS_OVERLAY := -f docker-compose.yml -f docker-compose.tls.yml

.PHONY: help setup bootstrap check doctor validate test lint \
        catalog catalog-validate media-status media-fetch generate schedule \
        templates pool reap host-image landing \
        installer-iso installer-iso-smoke installer-iso-test \		      docker build up up-plain up-remote run down logs ps exec check-compose \
		      setup-log docker-shell provision provision-plan console-recreate lan boot sweep sweep-key

help: ## Show this help message
	@echo "OnTrak — operator workflow"
	@echo "Usage: make <target>"
	@grep -E '^[a-zA-Z_:-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "New here? 'make run' starts OnTrak with whatever this machine has."

## ---- Bootstrap ----------------------------------------------------------

bootstrap: $(STAMP) ## Install the dependencies this checkout needs (idempotent)

docker: ## Make sure Docker and its Compose plugin are installed (installs them if missing)
	@bash $(BOOTSTRAP) --quiet --docker

setup: ## Install system tools, create the venv, install dependencies and seed .env
	bash $(BOOTSTRAP)

secrets: ## Create .env from .env.example and fill in the generated local secrets
	bash scripts/secrets.sh

check: | $(STAMP) ## Preflight: Python, Incus, KVM, storage and secrets
	$(PY) -m ontrak doctor

doctor: check ## Alias for `check`

## ---- Run anywhere -------------------------------------------------------

run: ## Start OnTrak with whatever this machine has: Docker, or the host portal
	@if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then \
	  echo "==> Docker is available: starting the container stack"; \
	  $(MAKE) --no-print-directory up; \
	else \
	  echo "==> No usable Docker: running the portal on this host instead"; \
	  echo "    (this machine can still run the portal; see docs/docker.md)"; \
	  $(MAKE) --no-print-directory serve; \
	fi

lan: ## Print the URL to open OnTrak from a phone or another device on the network
	@# The scheme and port follow which stack is up: `make up` (the default)
	@# publishes the TLS port *instead of* the plain one, so printing
	@# http://<addr>:8080 on a range that no longer listens there is worse than
	@# printing nothing. The certificate is the tell — the TLS overlay cannot start
	@# without it, and `make up-plain` does not write one.
	@if [ -f deploy/tls/ontrak.crt ]; then scheme="https"; port="$${ONTRAK_TLS_PORT:-8443}"; \
	else scheme="http"; port="$${ONTRAK_PORTAL__PORT:-8080}"; fi; \
	addr=""; \
	if command -v ip >/dev/null 2>&1; then \
	  addr="$$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($$i=="src") {print $$(i+1); exit}}')"; \
	fi; \
	[ -n "$$addr" ] || addr="$$(hostname -I 2>/dev/null | awk '{print $$1}')"; \
	if [ -n "$$addr" ]; then \
	  echo "$$scheme://$$addr:$$port"; \
	else \
	  echo "no LAN address found on this host (is it on a network?)"; \
	fi

## ---- Installer ISO (bare metal → range host) ---------------------------
# Builds a bootable Ubuntu 24.04 image that installs the host and then provisions
# itself on first boot: Incus, the lab, the OnTrak checkout and the portal stack.
# The operator answers one screen (identity). See docs/installer.md.

installer-iso: ## Build the bootable range-host installer ISO
	bash infra/build-installer-iso.sh

installer-iso-smoke: ## Build the installer ISO, then boot it in QEMU to prove it installs
	ONTRAK_ISO_SMOKE=1 bash infra/build-installer-iso.sh

installer-iso-test: ## Install a machine from the built ISO in QEMU, then check it over SSH
	@iso="$$(ls -t dist/*.iso 2>/dev/null | head -1)"; \
	test -n "$$iso" || { echo "no ISO in dist/ — run 'make installer-iso' first"; exit 2; }; \
	bash infra/installer/install-test.sh "$$iso"

## ---- Docker stack (portal + console gateway) ----------------------------

build: docker ## Build the portal image
	$(COMPOSE) build

## ---- Trust: DNS + TLS + edge through Cerulean ---------------------------
# This repo owns no nameserver and no CA. Cerulean does (docs/stack.md), and
# these two targets are the only supported way to put OnTrak's names on the
# estate: the plan writes nothing, and --apply is idempotent, so a re-run after
# a backend move is the same command. Needs CERULEAN_API_TOKEN (a ceru_ service
# key with the scopes domains, dns, certs, npm).

provision-plan: | $(STAMP) ## Show what Cerulean would change for ontrak's names (writes nothing)
	$(PY) scripts/cerulean-provision.py

provision: | $(STAMP) ## Provision DNS, certificates and edge hosts for OnTrak through Cerulean
	$(PY) scripts/cerulean-provision.py --apply

up: docker secrets ## One command: first-run setup, then start the stack with TLS on one port
	@# Encrypted by default. A range is reached directly on a network the operator
	@# does not own, so the origin publishes the TLS port *instead of* the plain one
	@# (docker-compose.tls.yml) and no unencrypted door is left beside it. Having to
	@# remember `make tls` was the same class of mistake as the loopback bind this
	@# replaced: the unencrypted posture was one forgotten word away. `make up-plain`
	@# is that older behaviour, for a host whose TLS edge already terminates in front.
	@#
	@# --build so a checkout that was just pulled does not silently run the
	@# image from an earlier commit; the cache makes this a second when nothing
	@# changed. Secrets are handled twice on purpose: here so an interrupted
	@# first run still leaves a usable .env, and inside lab-setup so that a bare
	@# `docker compose up` — with no .env at all — works the same way.
	@bash scripts/tls-local-cert.sh
	$(COMPOSE) $(TLS_OVERLAY) up -d --build
	@echo "==> portal    https://localhost:$${ONTRAK_TLS_PORT:-8443}/"
	@echo "==> console   https://localhost:$${ONTRAK_TLS_PORT:-8443}/guacamole/"
	@echo "==> sign in   local accounts by default — create the first one at /setup"
	@echo "            (SSO is optional; switch it on under Admin -> Sign-in after"
	@echo "             setting the ONTRAK_PORTAL__OIDC_* values in .env)"
	@echo "==> the certificate is self-signed: each device warns once until it is trusted"
	@echo "==> first run make setup-log   lab health: make exec ARGS=doctor"
	@echo "==> other devices   make lan"

up-plain: docker secrets ## Start the stack without TLS (plain HTTP) — a host behind a TLS edge
	@# The deployment case: Cerulean (or another edge) terminates TLS and forwards
	@# to this host, so encrypting here would be a second, redundant layer. The
	@# base stack publishes plain HTTP on the one port.
	$(COMPOSE) up -d --build
	@echo "==> portal    http://localhost:$${ONTRAK_PORTAL__PORT:-8080}"
	@echo "==> console   http://localhost:$${ONTRAK_PORTAL__PORT:-8080}/guacamole/"
	@echo "==> unencrypted here: correct only when a TLS edge terminates in front"
	@echo "==> other devices   make lan"

tls: up ## Alias for `up` (TLS is the default posture)

renew-tls: ## Re-issue the local TLS certificate (the host's address changed)
	@bash scripts/tls-local-cert.sh --force

up-remote: docker secrets ## Start the stack with no host hypervisor (remote cluster)
	$(COMPOSE) $(REMOTE_OVERLAY) up -d
	@echo "==> started without a host hypervisor — see docs/docker.md § remote"

setup-log: ## Show what the first-run lab setup did (secrets, Incus on the host)
	$(COMPOSE) logs lab-setup

console-recreate: ## Recreate just the console gateway, so its JSON_SECRET_KEY matches .env
	@# The failure this fixes is silent: a gateway created before the key existed (or
	@# with an older one) refuses every console link with "Permission denied", the
	@# iframe never opens, and both containers still report healthy. `make check`
	@# reports it — this is the one-value fix, without restarting the portal mid-class.
	$(COMPOSE) up -d --force-recreate guacamole
	@echo "==> recreated; now confirm: make check   (or: make exec ARGS=doctor)"

boot: ## Make the range start on boot with systemd (TLS, one published port)
	@# Survives a reboot with no operator: a lab host that comes back from a power
	@# cut and serves nothing is a support call. Writes an ontrak-range.service that
	@# runs the same TLS stack this checkout starts by hand. Needs sudo.
	@bash scripts/install-boot-service.sh

down: ## Stop the stack (keeps the state, media and secrets volumes)
	$(COMPOSE) down

logs: ## Follow the stack logs
	$(COMPOSE) logs -f

ps: ## Show stack containers and their health (including the one-shot first-run setup)
	$(COMPOSE) ps -a

check-compose: docker | $(STAMP) ## Validate the compose files, their env interpolation and the first-run contract
	@bash scripts/secrets.sh .env.compose-check >/dev/null
	$(COMPOSE) --env-file .env.compose-check config --quiet
	$(COMPOSE) --env-file .env.compose-check $(REMOTE_OVERLAY) config --quiet
	@rm -f .env.compose-check
	$(PY) scripts/check-first-run-contract.py
	@echo "==> compose files are valid"

exec: ## Run a CLI command inside the running portal (make exec ARGS="user list")
	@test -n "$(ARGS)" || { echo "usage: make exec ARGS=\"catalog list\""; exit 2; }
	$(COMPOSE) exec portal python3 -m ontrak $(ARGS)

docker-shell: docker build ## Open a shell in the image (for `ontrak catalog list`, debugging, …)
	docker run --rm -it --entrypoint /bin/bash $(IMAGE)

## ---- Development --------------------------------------------------------

test: | $(STAMP) ## Run the test suite (the platform, then the repo's own tooling)
	$(PY) -m pytest -q
	@# The tooling lives under scripts/, with hyphens in the file names, so its tests are
	@# unittest-style and sit beside it; `pytest`'s testpaths do not reach them. CI runs
	@# both halves, so this target does too — a suite that quietly omits 74 of its tests
	@# locally is how a green `make test` meets a red CI.
	$(PY) -m unittest discover -s scripts/tests -q

lint: | $(STAMP) ## Lint the Python tree
	$(PY) -m ruff check ontrak tests scripts

validate: | $(STAMP) ## Validate every scenario and the whole workload catalog
	$(PY) -m ontrak scenario validate
	$(PY) -m ontrak catalog validate

## ---- Workload catalog ---------------------------------------------------

catalog: | $(STAMP) ## List the catalog (see also: catalog-show, catalog-plan)
	$(PY) -m ontrak catalog list
	$(PY) -m ontrak catalog groups

catalog-validate: | $(STAMP) ## Validate every catalog manifest
	$(PY) -m ontrak catalog validate

media-status: | $(STAMP) ## Show which installation media is present, fetchable or operator-supplied
	$(PY) -m ontrak media status
	$(PY) -m ontrak media missing

media-fetch: | $(STAMP) ## Download the freely redistributable media (evaluation ISOs and images)
	$(PY) -m ontrak media fetch

## ---- Range operations ---------------------------------------------------

templates: | $(STAMP) ## Build every scenario template (boot, inject fault, snapshot as "clean")
	$(PY) -m ontrak template build --all

pool: | $(STAMP) ## Show warm-pool depth and template readiness
	$(PY) -m ontrak pool status

reap: | $(STAMP) ## Expire sessions, recycle idle ones, refill pools
	$(PY) -m ontrak reap

sweep: | $(STAMP) ## Grade every scenario in the pool on a real machine, then print the table
	@# `make validate` is the catalogue's own half of the truth: every scenario and
	@# manifest parses and agrees with itself. This is the half a manifest cannot
	@# claim — that the machine a student is handed is really broken, and that a
	@# correct repair is really graded — because both are facts about a booted VM.
	@# It hands out real machines, so it is an operator command and not a CI one.
	@#
	@# The repairs are the answers to the exercises, so they live outside this
	@# repository on purpose — in dist/sweep-repairs.json, which is ignored and
	@# survives the run. Both halves are graded whenever that key exists; without
	@# it the sweep still catches the more common failure, a fault that never made
	@# it into the snapshot:
	@#     make sweep-key                                       # write the key to fill in
	@#     make sweep ARGS="--repairs ~/sweep-repairs.json"     # a key kept elsewhere
	@#     make sweep ARGS="--pairs id-locked-account"          # one pair
	$(PY) scripts/grade-sweep.py $(ARGS)

sweep-key: | $(STAMP) ## Write dist/sweep-repairs.json, keyed by every scenario, to fill in
	@# The skeleton is generated from the catalogue, so a key can never fall behind a
	@# scenario the range really offers. Nothing is graded and no machine boots.
	$(PY) scripts/grade-sweep.py --write-repairs

serve: | $(STAMP) ## Run the student portal on the host (no containers)
	$(PY) -m ontrak serve

## ---- Scenario generation ------------------------------------------------

generate: | $(STAMP) ## List the fault primitives and the curated combinations
	$(PY) -m ontrak generate list

generate-matrix: | $(STAMP) ## Generate one scenario per fault primitive and validate it
	$(PY) -m ontrak generate matrix

## ---- Conformity ---------------------------------------------------------

landing: | $(STAMP) ## Serve the landing page locally for a quick look
	$(PY) -m http.server --directory web/landing 8080
