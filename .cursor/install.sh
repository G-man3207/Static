#!/usr/bin/env bash
# Idempotent Cloud Agent bootstrap for the Static browser extension.
# Installs Node dependencies, the Playwright Chromium browser (used by the
# headed MV3 e2e suite under xvfb), and Firefox + geckodriver (used by the
# Selenium Firefox smoke test). Safe to run repeatedly.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Installing npm dependencies (npm ci)"
npm ci

echo "==> Installing Playwright Chromium + system dependencies"
npx playwright install --with-deps chromium

FIREFOX_BIN="/opt/firefox/firefox"
if [ ! -x "$FIREFOX_BIN" ]; then
  echo "==> Installing Firefox (latest)"
  wget -q "https://download.mozilla.org/?product=firefox-latest-ssl&os=linux64&lang=en-US" -O /tmp/firefox.tar.xz
  sudo tar xJf /tmp/firefox.tar.xz -C /opt/
  rm -f /tmp/firefox.tar.xz
else
  echo "==> Firefox already present ($("$FIREFOX_BIN" --version 2>/dev/null || echo unknown))"
fi

GECKO_VERSION="0.37.0"
if ! command -v geckodriver >/dev/null 2>&1; then
  echo "==> Installing geckodriver v${GECKO_VERSION}"
  wget -q "https://github.com/mozilla/geckodriver/releases/download/v${GECKO_VERSION}/geckodriver-v${GECKO_VERSION}-linux64.tar.gz" -O /tmp/geckodriver.tar.gz
  sudo tar -xzf /tmp/geckodriver.tar.gz -C /usr/local/bin/
  rm -f /tmp/geckodriver.tar.gz
else
  echo "==> geckodriver already present ($(geckodriver --version 2>/dev/null | head -1))"
fi

echo "==> Bootstrap complete"
