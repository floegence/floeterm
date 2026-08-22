SHELL := /bin/bash

.DEFAULT_GOAL := check

GO_MODULES := terminal-go app/backend

.PHONY: check
check: release-workflow-check go-test-race go-vuln web-check e2e-check

.PHONY: release-workflow-check
release-workflow-check:
	@node --test .github/workflows/*.test.mjs
	@node scripts/check_release_version_consistency.mjs

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
	echo "==> terminal-web Chromium runtime"; \
	(cd terminal-web && npm exec playwright install chromium); \
	echo "==> terminal-web lint/test/browser/build/package artifact"; \
	(cd terminal-web && npm run lint && npm test && npm run test:browser && npm run build && npm run check:package-artifact); \
	echo "==> terminal-web npm audit"; \
	(cd terminal-web && npm audit --registry=https://registry.npmjs.org/ --audit-level=low) || \
	(cd terminal-web && npm audit --registry=https://registry.npmjs.org/ --audit-level=low)

.PHONY: app-web-prepare
app-web-prepare: terminal-web-prepare
	@set -euo pipefail; \
	echo "==> app/web npm ci"; \
	(cd app/web && npm ci); \
	echo "==> app/web lint/build/test"; \
	(cd app/web && npm run lint && npm run build && npm test); \
	echo "==> app/web npm audit"; \
	(cd app/web && npm audit --registry=https://registry.npmjs.org/ --audit-level=low) || \
	(cd app/web && npm audit --registry=https://registry.npmjs.org/ --audit-level=low)

.PHONY: web-check
web-check: app-web-prepare

.PHONY: e2e-check
e2e-check: app-web-prepare
	@set -euo pipefail; \
	echo "==> e2e npm ci"; \
	(cd e2e && npm ci); \
	echo "==> e2e Chromium runtime"; \
	(cd e2e && npm exec playwright install chromium); \
	echo "==> e2e unit and browser tests"; \
	if [[ -n "$${CI:-}" ]]; then \
		(cd e2e && xvfb-run -a npm test); \
	else \
		(cd e2e && npm test); \
	fi; \
	echo "==> e2e npm audit"; \
	(cd e2e && npm audit --registry=https://registry.npmjs.org/ --audit-level=low) || \
	(cd e2e && npm audit --registry=https://registry.npmjs.org/ --audit-level=low)

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
	(cd app/backend && go run -tags floeterm_native ./cmd/floeterm -addr 127.0.0.1:8280 -static ../web/dist -log-level debug -performance-diagnostics)

.PHONY: native-check
native-check:
	@(cd terminal-go && GOWORK=off go test -race -tags floeterm_native ./...)
	@(cd app/backend && GOWORK=off go test -race -tags floeterm_native ./...)

.PHONY: native-sanitizer-check
native-sanitizer-check:
	@set -euo pipefail; \
	if [[ "$$(uname -s)" == "Linux" ]]; then \
		(cd terminal-go && GOWORK=off go test -asan -tags floeterm_native ./...); \
	fi; \
	(cd terminal-go && GOWORK=off CGO_CFLAGS='-fsanitize=undefined' CGO_LDFLAGS='-fsanitize=undefined' go test -tags floeterm_native ./...)

.PHONY: dev
dev:
	@set -euo pipefail; \
	echo "==> backend (0.0.0.0:8080)"; \
	(cd app/backend && go run ./cmd/floeterm -addr 0.0.0.0:8080 -log-level debug) & BACK_PID="$$!"; \
	trap 'kill $$BACK_PID 2>/dev/null || true' EXIT INT TERM; \
	echo "==> web dev server (0.0.0.0:5173)"; \
	(cd app/web && npm ci && npm run dev -- --host 0.0.0.0)
