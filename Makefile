# ==========================================================================
# OnTrak — operator workflow
# Usage: make <target>   (see `make help`)
# ==========================================================================

.DEFAULT_GOAL := help
SHELL := /bin/bash
VENV := .venv
PY := $(VENV)/bin/python

COMPOSE := docker compose
IMAGE := $(if $(ONTRAK_IMAGE),$(ONTRAK_IMAGE),ontrak:local)
# Single-host lab: Docker runs the control plane, Incus runs the training
# machines, and the portal needs the host's Incus socket to reach them. Detected
# rather than assumed, and printed by `up` so it is never a silent choice.
INCUS_OVERLAY := $(shell test -S /var/lib/incus/unix.socket && echo -f docker-compose.incus.yml)

.PHONY: help setup secrets check doctor validate test lint demo \
        catalog catalog-validate media-status media-fetch generate schedule \
        templates pool reap demo-serve host-image landing \
        build up up-remote down logs ps exec check-compose docker-demo docker-shell

help: ## Show this help message
	@echo "OnTrak — operator workflow"
	@echo "Usage: make <target>"
	@grep -E '^[a-zA-Z_:-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

## ---- Bootstrap ----------------------------------------------------------

setup: ## Create the venv, install dependencies, install guard hooks, seed .env
	bash scripts/setup.sh

secrets: ## Create .env from .env.example and fill in the generated local secrets
	bash scripts/secrets.sh

check: ## Preflight: Python, Incus, KVM, storage and secrets
	$(PY) -m ontrak doctor

doctor: check ## Alias for `check`

## ---- Docker stack (portal + console gateway) ----------------------------

build: ## Build the portal image
	$(COMPOSE) build

up: secrets ## Start the stack (portal + Guacamole; adds host Incus when present)
	@if [ -n "$(INCUS_OVERLAY)" ]; then echo "==> /var/lib/incus/unix.socket found: the portal gets the host's Incus"; \
	 else echo "==> no local Incus socket: starting without hypervisor access (demo or remote cluster only)"; fi
	$(COMPOSE) $(INCUS_OVERLAY) up -d
	@echo "==> portal  http://localhost:$${ONTRAK_PORTAL__PORT:-8080}   console  http://localhost:$${ONTRAK_GUAC__PUBLIC_PORT:-8081}/guacamole/"

up-remote: secrets ## Start the stack without any hypervisor access (remote cluster / demo)
	$(COMPOSE) up -d

down: ## Stop the stack (keeps the state and media volumes)
	$(COMPOSE) $(INCUS_OVERLAY) down

logs: ## Follow the stack logs
	$(COMPOSE) $(INCUS_OVERLAY) logs -f

ps: ## Show stack containers and their health
	$(COMPOSE) $(INCUS_OVERLAY) ps

check-compose: ## Validate both compose files and their env interpolation
	@bash scripts/secrets.sh .env.compose-check >/dev/null
	$(COMPOSE) --env-file .env.compose-check config --quiet
	$(COMPOSE) --env-file .env.compose-check -f docker-compose.yml -f docker-compose.incus.yml config --quiet
	@rm -f .env.compose-check
	@echo "==> compose files are valid"

exec: ## Run a CLI command inside the running portal (make exec ARGS="user list")
	@test -n "$(ARGS)" || { echo "usage: make exec ARGS=\"catalog list\""; exit 2; }
	$(COMPOSE) $(INCUS_OVERLAY) exec portal python3 -m ontrak $(ARGS)

docker-demo: build ## Run a whole class inside the image, with no hypervisor at all
	docker run --rm $(IMAGE) demo run --students 6

docker-shell: build ## Open a shell in the image (for `ontrak catalog list`, debugging, …)
	docker run --rm -it --entrypoint /bin/bash $(IMAGE)

## ---- Development --------------------------------------------------------

test: ## Run the test suite
	$(PY) -m pytest -q

lint: ## Lint the Python tree
	$(PY) -m ruff check ontrak tests

validate: ## Validate every scenario and the whole workload catalog
	$(PY) -m ontrak scenario validate
	$(PY) -m ontrak catalog validate

## ---- Demo (no hypervisor required) --------------------------------------

demo: ## Run a full class through the portal-free demo (in-memory Incus)
	$(PY) -m ontrak demo run --students 6

demo-serve: ## Run the portal in demo mode (no Incus, no Windows, no secrets)
	$(PY) -m ontrak demo serve

## ---- Workload catalog ---------------------------------------------------

catalog: ## List the catalog (see also: catalog-show, catalog-plan)
	$(PY) -m ontrak catalog list
	$(PY) -m ontrak catalog groups

catalog-validate: ## Validate every catalog manifest
	$(PY) -m ontrak catalog validate

media-status: ## Show which installation media is present, fetchable or operator-supplied
	$(PY) -m ontrak media status
	$(PY) -m ontrak media missing

media-fetch: ## Download the freely redistributable media (evaluation ISOs and images)
	$(PY) -m ontrak media fetch

## ---- Range operations ---------------------------------------------------

templates: ## Build every scenario template (boot, inject fault, snapshot as "clean")
	$(PY) -m ontrak template build --all

pool: ## Show warm-pool depth and template readiness
	$(PY) -m ontrak pool status

reap: ## Expire sessions, recycle idle ones, refill pools
	$(PY) -m ontrak reap

serve: ## Run the student portal on the host (no containers)
	$(PY) -m ontrak serve

## ---- Scenario generation ------------------------------------------------

generate: ## List the fault primitives and the curated combinations
	$(PY) -m ontrak generate list

generate-matrix: ## Generate one scenario per fault primitive and validate it
	$(PY) -m ontrak generate matrix

## ---- Conformity ---------------------------------------------------------

landing: ## Serve the landing page locally for a quick look
	$(PY) -m http.server --directory web/landing 8080
