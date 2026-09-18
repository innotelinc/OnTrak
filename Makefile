# ==========================================================================
# OnTrak — operator workflow
# Usage: make <target>   (see `make help`)
# ==========================================================================

.DEFAULT_GOAL := help
SHELL := /bin/bash
VENV := .venv
PY := $(VENV)/bin/python

.PHONY: help setup check doctor validate test lint demo serve \
        catalog catalog-validate media-media media-fetch generate schedule \
        templates pool reap demo-serve host-image landing

help: ## Show this help message
	@echo "OnTrak — operator workflow"
	@echo "Usage: make <target>"
	@grep -E '^[a-zA-Z_:-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'

## ---- Bootstrap ----------------------------------------------------------

setup: ## Create the venv, install dependencies, install guard hooks, seed .env
	bash scripts/setup.sh

check: ## Preflight: Python, Incus, KVM, storage and secrets
	$(PY) -m ontrak doctor

doctor: check ## Alias for `check`

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

serve: ## Run the student portal
	$(PY) -m ontrak serve

## ---- Scenario generation ------------------------------------------------

generate: ## List the fault primitives and the curated combinations
	$(PY) -m ontrak generate list

generate-matrix: ## Generate one scenario per fault primitive and validate it
	$(PY) -m ontrak generate matrix

## ---- Conformity ---------------------------------------------------------

landing: ## Serve the landing page locally for a quick look
	$(PY) -m http.server --directory web/landing 8080
