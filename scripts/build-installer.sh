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

# 3. Bundle ESM to CJS
pnpm exec esbuild dist/server.js --bundle --format=cjs \
  --outfile=dist/server-bundle.cjs --platform=node \
  --external:better-sqlite3 \
  --external:@huggingface/transformers \
  --external:onnxruntime-node

# 4. Patch the CJS bundle for pkg compatibility
node scripts/patch-bundle.cjs

# 5. Clean old build output (prevents old .exe files from being
#    picked up by Inno Setup's "Source: build\*" wildcard)
rm -f installer/build/EnglishOralTeacher-Setup-v*.exe

# 6. Package into standalone exe
pnpm exec pkg dist/server-bundle.cjs --public \
  --targets node24-win-x64 \
  --output installer/build/EnglishOralTeacher.exe

# 7. Verify
ls -lh installer/build/EnglishOralTeacher.exe

echo "==> server .exe built: installer/build/EnglishOralTeacher.exe"
