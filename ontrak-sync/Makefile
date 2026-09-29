# Ontrak Sync — the commands you actually run.
#
# `make check` is the one to run before committing: it is the backend suite plus the
# frontend typecheck, which between them cover the parsers, the cron arithmetic, the
# finding lifecycle and the API's types. There is no linter target because the
# Network's Python is checked by the tests and the TypeScript by `tsc`.

SHELL := /bin/bash
COMPOSE := docker compose
PROJECT := ontrak-sync

.PHONY: help setup check test typecheck up down restart logs ps scan token images clean

help:
	@echo "Ontrak Sync"
	@echo "  make setup      bootstrap: guard hooks + .env (asks for nothing else)"
	@echo "  make check      backend tests + frontend typecheck"
	@echo "  make test       backend tests only (plain unittest, no pytest)"
	@echo "  make typecheck  tsc --noEmit"
	@echo "  make up         build and start the stack"
	@echo "  make down       stop the stack (the database volume is kept)"
	@echo "  make logs       follow both services"
	@echo "  make scan       trigger a scan through the API (needs ONTRAK_API_TOKEN)"
	@echo "  make token      generate a value for ONTRAK_API_TOKEN"

setup:
	bash scripts/setup.sh

check: test typecheck

test:
	cd backend && python3 tests/run-all.py

typecheck:
	cd web && npm install --no-audit --no-fund --silent && npm run typecheck

up:
	$(COMPOSE) up -d --build

down:
	$(COMPOSE) down

restart:
	$(COMPOSE) up -d --force-recreate

logs:
	$(COMPOSE) logs -f --tail=100

ps:
	$(COMPOSE) ps

# A scan through the API rather than by shelling into the container, because that
# exercises the same path the dashboard uses.
scan:
	@set -euo pipefail; \
	. ./.env; \
	curl -sS -X POST "http://$${ONTRAK_API_BIND:-192.168.1.21}:8420/api/scan" \
	  -H "Authorization: Bearer $$ONTRAK_API_TOKEN" \
	  -H 'Content-Type: application/json' -d '{}' | python3 -m json.tool

token:
	@openssl rand -hex 32

images:
	$(COMPOSE) build

clean:
	$(COMPOSE) down -v
