#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:?usage: build-node.sh <version>}"
DIST="dist/EnglishOralTeacher-v$VERSION-node"

echo "==> building node distribution for v$VERSION"
pnpm build
mkdir -p "$DIST"
cp -r dist/* "$DIST/"
cp package.json pnpm-lock.yaml "$DIST/"
cp README.md "$DIST/"
mkdir -p "$DIST/prompts"
cp prompts/USER.md.example prompts/SOUL.md prompts/AGENTS.md prompts/tools.md prompts/phases.md "$DIST/prompts/"
cp .env.example "$DIST/"
cp -r node_modules "$DIST/"

cd dist
zip -r "EnglishOralTeacher-v$VERSION-node.zip" "EnglishOralTeacher-v$VERSION-node/"
echo "==> node .zip built: dist/EnglishOralTeacher-v$VERSION-node.zip"
