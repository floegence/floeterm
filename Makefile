SHELL := /bin/bash

.DEFAULT_GOAL := check

GO_MODULES := terminal-go app/backend

.PHONY: check
check: go-test-race go-vuln web-check

.PHONY: go-test-race
go-test-race:
	@set -euo pipefail; \
	for m in $(GO_MODULES); do \
		echo "==> go test -race ($$m)"; \
		(cd $$m && go test -race ./...); \
	done

.PHONY: go-vuln
go-vuln:
	@set -euo pipefail; \
	for m in $(GO_MODULES); do \
		echo "==> govulncheck ($$m)"; \
		(cd $$m && go run golang.org/x/vuln/cmd/govulncheck@latest ./...); \
	done

.PHONY: terminal-web-prepare
terminal-web-prepare:
	@set -euo pipefail; \
	echo "==> terminal-web npm ci"; \
	(cd terminal-web && npm ci); \
	echo "==> terminal-web lint/test/build"; \
	(cd terminal-web && npm run lint && npm test && npm run build); \
	echo "==> terminal-web npm audit"; \
	(cd terminal-web && npm audit --audit-level=low)

.PHONY: app-web-prepare
app-web-prepare: terminal-web-prepare
	@set -euo pipefail; \
	echo "==> app/web npm ci"; \
	(cd app/web && npm ci); \
	echo "==> app/web lint/build/test"; \
	(cd app/web && npm run lint && npm run build && npm test); \
	echo "==> app/web npm audit"; \
	(cd app/web && npm audit --audit-level=low)

.PHONY: web-check
web-check: app-web-prepare

.PHONY: app-web-build
app-web-build:
	@set -euo pipefail; \
	echo "==> app/web npm ci"; \
	(cd app/web && npm ci); \
	echo "==> app/web build"; \
	(cd app/web && npm run build)

.PHONY: run
run: app-web-prepare
	@set -euo pipefail; \
	(cd app/backend && go run ./cmd/floeterm -addr :8080 -static ../web/dist -log-level debug)
