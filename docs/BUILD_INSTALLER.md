---
name: build-installer
description: Build the English Oral Teacher Windows installer .exe using esbuild + pkg.
---

# Build Installer

Build a standalone Windows .exe that bundles Node.js runtime + the English Oral
Teacher server.  Output lands at `installer/build/EnglishOralTeacher.exe`.

## Prerequisites

- Windows 10+ x64
- Node.js (see note below about matching pkg target)
- pnpm >= 9
- (optional) Inno Setup 6 for the final `-Setup-` wrapper

## First-time setup (new machine)

```bash
git clone https://github.com/zhiyicom/english-oral-teacher-agent.git
cd english-oral-teacher-agent
pnpm install
cp .env.example .env   # then edit .env with your API key
pnpm build
```
After these steps the project is ready for development (`pnpm dev-web`) and
for building the installer (see below).

## Quick start

```bash
cd "<project-root>"

# Step 0 — remove secrets before packaging (--public would include them!)
mv .env .env.bak
mv data data.bak

# Step 1 — build TypeScript + web
pnpm build

# Step 2 — bundle ESM → CJS via esbuild (must use --bundle)
pnpm exec esbuild dist/server.js --bundle --format=cjs \
  --outfile=dist/server-bundle.cjs --platform=node \
  --external:better-sqlite3 \
  --external:@huggingface/transformers \
  --external:onnxruntime-node

# Step 3 — patch the CJS bundle (import.meta.url, prompts path, inline SQL, SPA handlers)
node scripts/patch-bundle.cjs

# Step 4 — pkg compile (target must match installed Node version)
pnpm exec pkg dist/server-bundle.cjs --public --targets node24-win-x64 \
  --output installer/build/EnglishOralTeacher.exe

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

### Why ESM → CJS bundle with `--bundle`

`@yao-pkg/pkg` cannot resolve ESM package.json exports (e.g. `hono/streaming`).
esbuild's `--bundle` flag inlines every imported JS module into a single CJS
file. **Without `--bundle`, ESM imports become `require()` calls that fail at
runtime** because pkg's VFS loads ESM files in a way that `module.exports` is
not available (ReferenceError: module is not defined in ES module scope).

Native modules (`better-sqlite3`, `onnxruntime-node`, `@huggingface/transformers`)
are kept external via `--external` flags because esbuild cannot bundle `.node`
binary files.

### import.meta.url polyfill

esbuild CJS output produces `var import_meta = {}` (empty).  The patch script
replaces it with `{ url: require('url').pathToFileURL(__filename).href }`.

### Prompt files (.md) are inlined by patch-bundle.cjs

The patch script reads every prompt `.md` file and injects them as
`globalThis.EMBEDDED_PROMPTS` at the top of the bundle.  `src/prompts/loader.ts`
reads from this global at runtime with a disk fallback for dev mode.

### Migration files (.sql) are inlined by the patch script

pkg's VFS does not include non-JS files via directory scanning.  The patch
script reads every `dist/migrations/*.sql`, embeds them as a JSON object, and
rewrites `applyMigrations()` to use the inlined data.

### Web assets (SPA) are inlined by the patch script

All files under `dist/web/` are base64-encoded and embedded as `WEB_ASSETS`.
The patch script rewrites the SPA-serving route handlers (`/assets/*` and `/*`)
to serve from memory with a disk fallback.

### SPA handler regex — `c\d*` pattern

When esbuild runs with `--bundle`, it renames callback parameters (e.g. `c`
→ `c2`) and module imports (e.g. `import_node_path3` → `import_node_path7`).
The regex patterns in `patch-bundle.cjs` use `\(c\d*\)` to match both forms.

### better-sqlite3 native binding

The `bindings` package walks up from the module path looking for
`package.json` or `node_modules`.  pkg's `--public` flag includes
`package.json` in the VFS, so the walk succeeds.  `src/storage/db.ts` also
passes `nativeBinding` via `require.resolve` as a fallback.

### pkg target must match installed Node ABI

The exe bundles a Node runtime for the specified target. The `better-sqlite3`
native module must be compiled for the same NODE_MODULE_VERSION:

| Node version | NODE_MODULE_VERSION | pkg target |
|---|---|---|
| Node 22 | 127 | `node22-win-x64` |
| Node 24 | 137 | `node24-win-x64` |

If the build machine has Node 24, use `node24-win-x64`. Mismatched versions
cause `NODE_MODULE_VERSION` errors at startup.

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
| `module is not defined in ES module scope` | Add `--bundle` to esbuild command |
| `Cannot find module hono/streaming` | esbuild warning is harmless — the CJS bundle works correctly |
| `sharp/build/Release` warnings | Harmless — our MiniLM embedding doesn't use sharp (image processing) |
| `SPA not built. Run pnpm build first.` | `patch-bundle.cjs` SPA handler regex didn't match; check `c\d*` pattern |
| esbuild `.node` file error | Add `--external:onnxruntime-node` to exclude the native binding |
