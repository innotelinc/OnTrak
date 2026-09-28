# ═══════════════════════════════════════════════════════════════════════════
# OnTrak — operator workflow.
#
# `make help` is the first stop. Every target carries a `##` description, so
# help stays accurate without being maintained twice.
#
# Two apps live here and stay independently deployable, so the targets that
# only make sense for one of them say so: `TIX` targets run in ontrak-tix/,
# everything else runs in the training app at the repo root. Nothing above
# `## ---- Delivery ----` talks to a remote or changes published state.
# ═══════════════════════════════════════════════════════════════════════════

SHELL := /bin/bash
.DEFAULT_GOAL := help
TIX_DIR := ontrak-tix

## ---- Bootstrap ----

.PHONY: help
help: ## Show this help
	@awk 'BEGIN {FS = ":.*?## "} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2} /^## / {printf "\n\033[1m%s\033[0m\n", substr($$0, 4)}' $(MAKEFILE_LIST)

.PHONY: setup
setup: hooks ## Install guard hooks, create .env, install dependencies
	@if [ ! -f .env ]; then cp .env.example .env; echo "created .env (edit AUTH_SECRET before deploying)"; fi
	npm install

.PHONY: hooks
hooks: ## Point git at the shared attribution/secret guard hooks
	git config core.hooksPath .githooks
	@echo "hooks: .githooks installed"

## ---- Containers ----
# Each app is its own stack. `up`/`down`/`logs` are the training app's; the
# `tix-`-prefixed twins are the service desk's. `ps` and `images` cover both.
# Both stacks publish 5432 by default, so run only one at a time — or set
# ONTRAK_DB_PORT / ONTRAK_TIX_DB_PORT to separate them.

.PHONY: up
up: ## Build and start the training app + Postgres, serving on :3000
	docker compose up -d --build

.PHONY: down
down: ## Stop the training app stack (keeps its volumes)
	docker compose down

.PHONY: logs
logs: ## Tail the training app stack's logs
	docker compose logs -f

.PHONY: tix-up
tix-up: ## Build and start Tix + Postgres, serving on :3001
	cd $(TIX_DIR) && docker compose up -d --build

.PHONY: tix-down
tix-down: ## Stop the Tix stack (keeps its volumes)
	cd $(TIX_DIR) && docker compose down

.PHONY: tix-logs
tix-logs: ## Tail the Tix stack's logs
	cd $(TIX_DIR) && docker compose logs -f

.PHONY: ps
ps: ## List the containers in both stacks
	docker compose ps
	cd $(TIX_DIR) && docker compose ps

.PHONY: images
images: ## Build both production images without starting anything
	docker build --target runner -t ontrak-training:local .
	cd $(TIX_DIR) && docker build --target runner -t ontrak-tix:local .

.PHONY: check-compose
check-compose: ## Validate both development compose files against their .env.example
	@cp -n .env.example .env 2>/dev/null || true
	docker compose config --quiet && echo "compose: training ok"
	@cp -n $(TIX_DIR)/.env.example $(TIX_DIR)/.env 2>/dev/null || true
	cd $(TIX_DIR) && docker compose config --quiet && echo "compose: tix ok"

.PHONY: prod-check
prod-check: ## Validate both deployment overlays (throwaway secrets, cleaned up)
	@set -e; for d in . $(TIX_DIR); do \
	  made=; \
	  if [ ! -f "$$d/.env.production" ]; then \
	    cp "$$d/.env.production.example" "$$d/.env.production"; made=1; \
	  fi; \
	  ( cd "$$d" && AUTH_SECRET=check TIX_AUTH_SECRET=check POSTGRES_PASSWORD=check \
	      docker compose -f docker-compose.yml -f docker-compose.prod.yml config --quiet ); \
	  echo "compose: $$d prod ok"; \
	  if [ -n "$$made" ]; then rm -f "$$d/.env.production"; fi; \
	done

## ---- Deployments ----
# The overlays demand real secrets, so these need `.env.production` — copy the
# `.env.production.example` beside the compose file and fill it in. `prod-check`
# above validates them without one.

.PHONY: prod-up
prod-up: ## Start the training app as a deployment (needs .env.production)
	docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --build

.PHONY: prod-down
prod-down: ## Stop the training app deployment (keeps its volumes)
	docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml down

.PHONY: tix-prod-up
tix-prod-up: ## Start Tix as a deployment (needs .env.production)
	cd $(TIX_DIR) && docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --build

.PHONY: tix-prod-down
tix-prod-down: ## Stop the Tix deployment (keeps its volumes)
	cd $(TIX_DIR) && docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml down

## ---- The training app ----

.PHONY: db
db: ## Start the development PostgreSQL (Docker)
	docker compose up -d db

.PHONY: migrate
migrate: ## Generate the Prisma client and apply migrations
	npx prisma generate && npx prisma migrate deploy

.PHONY: seed
seed: ## Reset and seed the demo scenarios, courses and accounts
	npm run setup

.PHONY: dev
dev: ## Run the training app (http://localhost:3000)
	npm run dev

## ---- OnTrak Tix ----

.PHONY: tix-setup
tix-setup: ## Install dependencies for the service desk
	cd $(TIX_DIR) && npm install

.PHONY: tix-db
tix-db: ## Start Tix's own development PostgreSQL (Docker)
	cd $(TIX_DIR) && docker compose up -d db

.PHONY: tix-schema
tix-schema: ## Generate the Prisma client and sync Tix's schema
	cd $(TIX_DIR) && npx prisma generate && npx prisma db push

.PHONY: tix-dev
tix-dev: ## Run the service desk (http://localhost:3000)
	cd $(TIX_DIR) && npm run dev

.PHONY: tix-sweep
tix-sweep: ## Run the retention sweep without HTTP (a dry run unless FORCE=1)
	cd $(TIX_DIR) && npm run sweep:retention

## ---- Checks (what CI runs) ----

.PHONY: check
check: typecheck test build ## Everything CI runs, in the order CI runs it

.PHONY: typecheck
typecheck: ## Typecheck both apps
	npm run typecheck
	cd $(TIX_DIR) && npm run typecheck

.PHONY: test
test: ## Run both unit-test suites
	npm test
	cd $(TIX_DIR) && npm test

.PHONY: build
build: ## Production-build both apps
	npm run build
	cd $(TIX_DIR) && npm run build

.PHONY: conform
conform: ## Audit this repo against the Innotel Platform Stack standard
	@if [ -d .stack ]; then bash .stack/scripts/conform-project.sh .; \
	else echo "fetch it first: git clone https://github.com/innotelinc/innotel-platform-stack .stack"; exit 1; fi

.PHONY: guard
guard: ## Prove the attribution guard still rejects what it must
	bash -o pipefail -c 'source .githooks/guard-lib; guard_selftest --self-commit'

.PHONY: secrets
secrets: ## Scan the tracked tree for credential-shaped content
	python3 scripts/secret-scan.py

## ---- Delivery ----

.PHONY: clean
clean: ## Remove build output and test artifacts
	rm -rf .next out $(TIX_DIR)/.next test-results playwright-report tsconfig.tsbuildinfo
