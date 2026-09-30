# ═══════════════════════════════════════════════════════════════════════════
# OnTrak — operator workflow.
#
# `make help` is the first stop. Every target carries a `##` description, so
# help stays accurate without being maintained twice.
#
# Five products live here and stay independently deployable, so the targets that
# only make sense for one of them say so: `TIX` targets run in ontrak-tix/,
# `SENTINEL` targets in ontrak-sentinel/, `SYNC` ones in ontrak-sync/ (which has
# its own Makefile for the backend suite) and `PORTAL` ones in ontrak-portal/.
# Everything else is the training app at the repo root. Nothing above
# `## ---- Delivery ----` talks to a remote or changes published state.
# ═══════════════════════════════════════════════════════════════════════════

SHELL := /bin/bash
.DEFAULT_GOAL := help
TIX_DIR := ontrak-tix
SENTINEL_DIR := ontrak-sentinel
SYNC_DIR := ontrak-sync
PORTAL_DIR := ontrak-portal

GENIE_DIR := ontrak-genie

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
# Each product is its own stack. `up`/`down`/`logs` are the training app's; the
# `tix-`-prefixed twins are the service desk's, the `sentinel-` ones are the
# identity provider's, and `sync-`/`portal-` are OnTrak Sync's and the family
# portal's. `ps` covers all five.
#
# The training app and Tix both publish 5432 by default, so run only one of
# *those* at a time — or set ONTRAK_DB_PORT / ONTRAK_TIX_DB_PORT to separate
# them. Sentinel publishes its own database on 5434 and shares it with nobody.

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

.PHONY: sentinel-up
sentinel-up: ## Build and start Sentinel + Postgres, serving on :8787
	cd $(SENTINEL_DIR) && docker compose up -d --build

.PHONY: sentinel-down
sentinel-down: ## Stop the Sentinel stack (keeps its database volume)
	cd $(SENTINEL_DIR) && docker compose down

.PHONY: sentinel-logs
sentinel-logs: ## Tail the Sentinel stack's logs
	cd $(SENTINEL_DIR) && docker compose logs -f

.PHONY: sync-up
sync-up: ## Build and start OnTrak Sync's API + dashboard (:8420/:8421)
	cd $(SYNC_DIR) && docker compose up -d --build

.PHONY: sync-down
sync-down: ## Stop the OnTrak Sync stack (keeps its database volume)
	cd $(SYNC_DIR) && docker compose down

.PHONY: sync-logs
sync-logs: ## Tail the OnTrak Sync stack's logs
	cd $(SYNC_DIR) && docker compose logs -f

.PHONY: portal-up
portal-up: ## Build and start the portal, serving on :3300
	cd $(PORTAL_DIR) && docker compose up -d --build

.PHONY: portal-down
portal-down: ## Stop the portal stack
	cd $(PORTAL_DIR) && docker compose down

.PHONY: portal-logs
portal-logs: ## Tail the portal stack's logs
	cd $(PORTAL_DIR) && docker compose logs -f

.PHONY: genie-up
genie-up: ## Build and start the agent console stack, serving on :3410 (:3400 belongs to the family stack)
	cd $(GENIE_DIR) && docker compose up -d --build

.PHONY: genie-down
genie-down: ## Stop the agent console stack
	cd $(GENIE_DIR) && docker compose down

.PHONY: genie-logs
genie-logs: ## Tail the agent console's logs
	cd $(GENIE_DIR) && docker compose logs -f

# The family stack: all five products, one network, one command. `up`/`down`
# above are the training app's; this brings up everything, with Tix's outbound
# provisioning already pointed at the provider over the network and the portal's
# password sign-in already pointed at OnTrak Sync. See the header of
# docker-compose.all.yml for what single sign-on additionally needs.

.PHONY: all-up
all-up: ## Build and start all six products together (:3400, :3300, :3000, :3001, :8787, :8420/8421)
	docker compose -f docker-compose.all.yml up -d --build

.PHONY: all-down
all-down: ## Stop the family stack (keeps every volume)
	docker compose -f docker-compose.all.yml down

.PHONY: all-logs
all-logs: ## Tail the family stack's logs
	docker compose -f docker-compose.all.yml logs -f

.PHONY: all-demo
all-demo: ## Load the demo data for both apps in the family stack
	docker compose -f docker-compose.all.yml --profile demo run --rm training-seed
	docker compose -f docker-compose.all.yml --profile demo run --rm tix-seed

.PHONY: ps
ps: ## List the containers in all five stacks
	docker compose ps
	cd $(TIX_DIR) && docker compose ps
	cd $(SENTINEL_DIR) && docker compose ps
	cd $(SYNC_DIR) && docker compose ps
	cd $(PORTAL_DIR) && docker compose ps
	cd $(GENIE_DIR) && docker compose ps

.PHONY: images
images: ## Build the training, Tix and Sentinel images without starting anything
	docker build --target runner -t ontrak-training:local .
	cd $(TIX_DIR) && docker build --target runner -t ontrak-tix:local .
	cd $(SENTINEL_DIR) && docker build --target runner -t ontrak-sentinel:local .

.PHONY: sync-images
sync-images: ## Build the OnTrak Sync API + dashboard images without starting anything
	cd $(SYNC_DIR) && docker compose build

.PHONY: portal-images
portal-images: ## Build the portal image without starting anything
	cd $(PORTAL_DIR) && docker compose build

.PHONY: genie-images
genie-images: ## Build the agent console image without starting anything
	cd $(GENIE_DIR) && docker compose build

.PHONY: family-image
family-image: ## Build the family stack's images without starting anything
	docker compose -f docker-compose.all.yml build

.PHONY: check-compose
check-compose: ## Validate every development compose file against its .env.example
	@cp -n .env.example .env 2>/dev/null || true
	docker compose config --quiet && echo "compose: training ok"
	@cp -n $(TIX_DIR)/.env.example $(TIX_DIR)/.env 2>/dev/null || true
	cd $(TIX_DIR) && docker compose config --quiet && echo "compose: tix ok"
	# Sentinel's stack starts on defaults and needs no `.env`, so there is
	# nothing to copy in before validating it.
	cd $(SENTINEL_DIR) && docker compose config --quiet && echo "compose: sentinel ok"
	@cp -n $(SYNC_DIR)/.env.example $(SYNC_DIR)/.env 2>/dev/null || true
	cd $(SYNC_DIR) && docker compose config --quiet && echo "compose: sync ok"
	@cp -n $(PORTAL_DIR)/.env.example $(PORTAL_DIR)/.env 2>/dev/null || true
	cd $(PORTAL_DIR) && docker compose config --quiet && echo "compose: portal ok"
	# The family stack reads the other four `.env` files, which the lines above
	# have just made sure exist.
	docker compose -f docker-compose.all.yml config --quiet && echo "compose: family ok"

.PHONY: prod-check
prod-check: ## Validate all three deployment overlays (throwaway secrets, cleaned up)
	@set -e; for d in . $(TIX_DIR) $(SENTINEL_DIR); do \
	  made=; \
	  if [ ! -f "$$d/.env.production" ]; then \
	    cp "$$d/.env.production.example" "$$d/.env.production"; made=1; \
	  fi; \
	  ( cd "$$d" && AUTH_SECRET=check TIX_AUTH_SECRET=check POSTGRES_PASSWORD=check \
	      SENTINEL_SIGNING_KEY=check SENTINEL_ISSUER=check \
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

.PHONY: sentinel-prod-up
sentinel-prod-up: ## Start Sentinel as a deployment (needs .env.production)
	cd $(SENTINEL_DIR) && docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml up -d --build

.PHONY: sentinel-prod-down
sentinel-prod-down: ## Stop the Sentinel deployment (keeps its volume)
	cd $(SENTINEL_DIR) && docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml down

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

## ---- OnTrak Sentinel ----

.PHONY: sentinel-setup
sentinel-setup: ## Install dependencies for the identity provider
	cd $(SENTINEL_DIR) && npm install

.PHONY: sentinel-key
sentinel-key: ## Print a signing key as the escaped one-line PEM .env.production wants
	@openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null \
	  | awk 'NF {printf "%s\\n", $$0}'

.PHONY: sentinel-migrate
sentinel-migrate: ## Generate the Prisma client and apply the provider's migrations
	cd $(SENTINEL_DIR) && npx prisma generate && npx prisma migrate deploy

.PHONY: sentinel-serve
sentinel-serve: ## Run the identity provider from source (http://localhost:8787)
	cd $(SENTINEL_DIR) && npm run serve

## ---- Checks (what CI runs) ----

.PHONY: check
check: theme typecheck test build ## Everything CI runs, in the order CI runs it

.PHONY: theme
theme: ## Prove every product ships the canonical theme, byte for byte
	python3 theme/tests/test_theme_copies.py

.PHONY: typecheck
typecheck: ## Typecheck all five products
	npm run typecheck
	cd $(TIX_DIR) && npm run typecheck
	cd $(SENTINEL_DIR) && npm run typecheck
	cd $(SYNC_DIR)/web && npm run typecheck
	cd $(PORTAL_DIR) && npm run typecheck

.PHONY: test
test: ## Run every unit-test suite (OnTrak Sync's is plain unittest)
	npm test
	cd $(TIX_DIR) && npm test
	cd $(SENTINEL_DIR) && npm test
	cd $(SYNC_DIR)/backend && python3 tests/run-all.py
	cd $(PORTAL_DIR) && npm test

.PHONY: build
build: ## Production-build the three Next apps (Sentinel has no build step)
	npm run build
	cd $(TIX_DIR) && npm run build
	cd $(PORTAL_DIR) && npm run build

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
