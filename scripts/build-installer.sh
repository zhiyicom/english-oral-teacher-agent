#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: build-installer.sh <version>}"
echo "==> building installer for v$VERSION"

# 1. Build server + web
pnpm install --frozen-lockfile
pnpm build

# 2. Inject version into server bundle
VERSION="$VERSION" pnpm build:copy-assets

# 3. pkg
pnpm exec pkg installer/pkg.config.json \
  --options "version=$VERSION" \
  --output installer/build/EnglishOralTeacher.exe

# 4. Verify
ls -lh installer/build/EnglishOralTeacher.exe

echo "==> server .exe built: installer/build/EnglishOralTeacher.exe"
