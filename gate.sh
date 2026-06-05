#!/usr/bin/env bash
set -euo pipefail

# gate.sh — Quality gates for the Static Chrome extension.
# Run with no flags for the full suite.
#  --fast    Skip browser E2E tests (static-only check).
#  --lint    Only formatting + linting (no tests).
#  --e2e     Only browser E2E tests (skips static checks).
#  --docker  Run E2E tests inside a Docker container (xvfb).

cd "$(dirname "$0")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

GATE_FAILED=0

pass()  { echo -e "${GREEN}[PASS]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; GATE_FAILED=1; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
header() { echo ""; echo "=== $1 ==="; }

RUN_FAST=false
RUN_LINT=false
RUN_E2E=false

for arg in "$@"; do
  case "$arg" in
    --fast|--quick) RUN_FAST=true; RUN_LINT=true ;;
    --lint|--lint-strict) RUN_LINT=true ;;
    --static) RUN_FAST=true ;;
    --e2e|--e2e-xvfb) RUN_E2E=true ;;
    --ci|--all) RUN_FAST=true; RUN_LINT=true; RUN_E2E=true ;;
    --docker) USE_DOCKER=true ;;
    --format) ;;
    *) echo "Unknown flag: $arg"; exit 1 ;;
  esac
done

# If no selective flags, run everything.
if ! $RUN_FAST && ! $RUN_LINT && ! $RUN_E2E; then
  RUN_FAST=true
  RUN_LINT=true
  RUN_E2E=true
fi

# ---------------------------------------------------------------------------
# Gate 1 — Manifest / JSON validation (static)
# ---------------------------------------------------------------------------
header "Manifest & JSON validation"
node -e "
  const fs = require('fs');
  const path = require('path');
  let errors = 0;

  // manifest.json
  try {
    const m = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
    if (m.manifest_version !== 3) { console.log('manifest_version must be 3'); errors++; }
    if (!m.name)                   { console.log('manifest missing name'); errors++; }
    if (!m.version)                { console.log('manifest missing version'); errors++; }
    if (!Array.isArray(m.content_scripts) || m.content_scripts.length === 0) {
      console.log('manifest missing content_scripts'); errors++;
    }
    // Verify all content script files exist
    for (const cs of m.content_scripts) {
      for (const js of (cs.js || [])) {
        if (!fs.existsSync(js)) { console.log('missing content script: ' + js); errors++; }
      }
    }
    // Verify service worker exists
    if (!m.background || !fs.existsSync(m.background.service_worker || '')) {
      console.log('missing or invalid background.service_worker'); errors++;
    }
    // Verify DNR rule resources exist
    for (const r of (m.declarative_net_request?.rule_resources || [])) {
      if (!fs.existsSync(r.path)) { console.log('missing DNR ruleset: ' + r.path); errors++; }
    }
  } catch (e) { console.log('manifest.json parse error: ' + e.message); errors++; }

  // rules/ JSON validation
  for (const f of ['rules/fingerprint_vendors.json', 'rules/captcha_vendors.json']) {
    try {
      const rules = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (!Array.isArray(rules)) { console.log(f + ' is not an array'); errors++; }
    } catch (e) { console.log(f + ' parse error: ' + e.message); errors++; }
  }

  // rules/META.json
  try {
    const meta = JSON.parse(fs.readFileSync('rules/META.json', 'utf8'));
  } catch (e) { console.log('rules/META.json parse error: ' + e.message); errors++; }

  if (errors > 0) process.exit(1);
" && pass "JSON validation" || fail "JSON validation"

# ---------------------------------------------------------------------------
# Gate 2 — Formatting check
# ---------------------------------------------------------------------------
if $RUN_LINT || $RUN_FAST; then
  header "Prettier format check"
  find . \( -path ./node_modules -o -path ./_metadata -o -path ./test-results -o -path ./playwright-report -o -path ./.git \) -prune -o -type f \( -name '*.js' -o -name '*.html' -o -name '*.json' -o -name '*.md' -o -name '*.yml' \) -print0 | xargs -0 npx prettier --check 2>&1 && pass "Formatting" || fail "Formatting"
fi

# ---------------------------------------------------------------------------
# Gate 3 — ESLint
# ---------------------------------------------------------------------------
if $RUN_LINT || $RUN_FAST; then
  header "ESLint"
  npx eslint . --max-warnings=0 2>&1 && pass "Linting" || fail "Linting"
fi

# ---------------------------------------------------------------------------
# Gate 4 — Static tests (no browser)
# ---------------------------------------------------------------------------
if $RUN_FAST; then
  header "Static validation tests"
  npx playwright test tests/static-validation.spec.js 2>&1 && pass "Static tests" || fail "Static tests"
fi

# ---------------------------------------------------------------------------
# Gate 5 — Browser E2E tests
if $RUN_E2E; then
  header "Browser E2E tests"
  # Use the same explicit spec list as npm run test:e2e
  E2E_SPECS="tests/globals-stealth.spec.js tests/bridge-flush.spec.js tests/extension-behavior.spec.js tests/fingerprint-masking.spec.js tests/fingerprint-depth.spec.js tests/fingerprint-vectors.spec.js tests/replay-datadog.spec.js tests/replay-hotjar.spec.js tests/replay-openreplay.spec.js tests/replay-posthog.spec.js tests/replay-sentry.spec.js tests/replay-depth.spec.js tests/edge-privacy.spec.js tests/worklet-vectors.spec.js tests/svg-href.spec.js tests/noise-xhr-consistency.spec.js tests/noise-canary.spec.js tests/adversarial-consistency.spec.js tests/stealth-hardness.spec.js tests/decoy-serialization.spec.js"
  if ${USE_DOCKER:-false}; then
    docker run --rm --user "$(id -u):$(id -g)" --ipc=host -v "$PWD":/work -w /work --network host \
      mcr.microsoft.com/playwright:v1.59.1-noble \
      xvfb-run -a npx playwright test $E2E_SPECS --project=chromium 2>&1 && pass "E2E (Docker)" || fail "E2E (Docker)"
  else
    xvfb-run npx playwright test $E2E_SPECS --project=chromium 2>&1 && pass "E2E" || fail "E2E"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
if [ "$GATE_FAILED" -eq 0 ]; then
  echo -e "${GREEN}All gates passed${NC}"
  exit 0
else
  echo -e "${RED}Some gates failed${NC}"
  exit 1
fi
