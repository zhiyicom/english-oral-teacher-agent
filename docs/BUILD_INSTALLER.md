---
name: build-installer
description: Build the English Oral Teacher Windows installer .exe using esbuild + pkg.
---

# Build Installer

Build a standalone Windows .exe that bundles Node.js runtime + the English Oral
Teacher server.  Output lands at `installer/build/EnglishOralTeacher.exe`.

## Prerequisites

- Windows 10+ x64
- Node.js 24.x
- pnpm >= 9
- (optional) Inno Setup 6 for the final `-Setup-` wrapper

## Quick start

```bash
cd "<project-root>"

# Step 0 — remove secrets before packaging (--public would include them!)
mv .env .env.bak
mv data data.bak

# Step 1 — build TypeScript + web
pnpm build

# Step 2 — bundle ESM → CJS via esbuild
node node_modules/.pnpm/esbuild@0.28.0/node_modules/esbuild/bin/esbuild \
  dist/server.js --bundle --platform=node --target=node22 --format=cjs \
  --outfile=dist/server-bundle.cjs --packages=external \
  --loader:.md=text --loader:.example=text

# Step 3 — patch the CJS bundle (import.meta.url, prompts path, inline SQL)
node scripts/patch-bundle.cjs

# Step 4 — pkg compile
pnpm exec pkg dist/server-bundle.cjs --public --targets node24-win-x64 \
  -o installer/build/EnglishOralTeacher.exe --compress GZip --fallback-to-source

# Restore secrets
mv .env.bak .env
mv data.bak data

# Step 5 — verify (run from /tmp to simulate user environment — no .env in CWD)
rm -rf /tmp/exe-test-data
cd /tmp
APP_DATA_DIR=/tmp/exe-test-data <project-root>/installer/build/EnglishOralTeacher.exe &
sleep 5
curl http://localhost:8787/api/health
# → {"ok":true,"sessions":0}
curl http://localhost:8787/api/setup/status
# → {"needsApiKey":true,...}   ← ensures API key was NOT bundled
```

## Key design decisions

### Why ESM → CJS bundle

`@yao-pkg/pkg` cannot resolve ESM package.json exports (e.g. `hono/streaming`).
esbuild bundles every ESM module into a single CJS file, bypassing the issue.

### import.meta.url polyfill

esbuild CJS output produces `var import_meta = {}` (empty).  The patch script
replaces it with `{ url: require('url').pathToFileURL(__filename).href }`.

### Prompt files (.md) are inlined by esbuild

`src/prompts/loader.ts` uses native text imports:
```ts
import SOUL_MD from '../../prompts/SOUL.md' with { type: 'text' }
```
esbuild's `--loader:.md=text` inlines content at bundle time — zero filesystem
reads needed at runtime.

### Migration files (.sql) are inlined by the patch script

pkg's VFS does not include non-JS files.  The patch script reads every
`dist/migrations/*.sql`, embeds them as a JSON object, and rewrites
`applyMigrations()` to use the inlined data instead of `readdirSync` +
`readFileSync`.

### better-sqlite3 native binding

The `bindings` package walks up from the module path looking for
`package.json` or `node_modules`.  pkg's `--public` flag includes
`package.json` in the VFS, so the walk succeeds.  `src/storage/db.ts` also
passes `nativeBinding` via `require.resolve` as a fallback.

### node24 target

pkg's embedded Node version must match the locally-installed Node ABI
(NODE_MODULE_VERSION).  Node v24 = version 137.  If you upgrade Node on
this machine, change the `--targets` flag.

## Optional: Inno Setup wrapper

On a Windows machine with [Inno Setup 6](https://jrsoftware.org/isdl.php):

```cmd
iscc installer\installer.iss
```

Produces `installer/build/EnglishOralTeacher-Setup-v1.0.6.exe` — a proper
Windows installer with start-menu shortcuts, desktop icon, uninstaller,
and upgrade detection.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `table sessions already exists` | Delete `data/oral-teacher.db` first |
| `NODE_MODULE_VERSION mismatch` | Match `--targets nodeXX-win-x64` to your Node version |
| `Cannot find module hono/streaming` | esbuild `--packages=external` is working correctly — the warning is harmless |
| `sharp/build/Release` warnings | Harmless — our MiniLM embedding doesn't use sharp (image processing) |
