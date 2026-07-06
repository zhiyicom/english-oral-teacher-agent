// scripts/patch-bundle.cjs
// v1.0.6 — post-process the esbuild CJS bundle so pkg can consume it.
//
// 1. Replace import.meta.url with CJS __filename equivalent
// 2. Fix PROMPTS_DIR to use dirname(__filename) instead of __dirname
//    (in pkg snapshot __filename is the correct anchor)
// 3. Inline SQL migration files into applyMigrations()
//
// Run after:  esbuild dist/server.js --bundle --format=cjs --outfile=dist/server-bundle.cjs --platform=node --external:better-sqlite3
// Run before: pkg dist/server-bundle.cjs --public --targets node24-win-x64

const fs = require('fs')
const path = require('path')

const BUNDLE = 'dist/server-bundle.cjs'
let content = fs.readFileSync(BUNDLE, 'utf-8')

// --- 1. import.meta.url shim ---
content = content.replace(/var import_meta(\d*) = \{\};/g, (_, n) => {
  return `var import_meta${n} = { url: require("url").pathToFileURL(__filename).href };`
})

// --- 2. PROMPTS_DIR — preserve the existing import_node_pathN var name ---
content = content.replace(
  /var PROMPTS_DIR = \(0, import_node_fs\d+\.existsSync\)\(\(0, (import_node_path\d+)\.join\)\(__dirname, "prompts"\)\) \? \(0, \1\.join\)\(__dirname, "prompts"\) : \(0, \1\.join\)\(__dirname, "\.\.", "\.\.", "prompts"\);/,
  (_match, pathVar) => {
    return `var PROMPTS_DIR = (0, ${pathVar}.join)((0, ${pathVar}.dirname)(__filename), "prompts");`
  }
)

// --- 3. Inline SQL migrations ---
const migrationsDir = 'dist/migrations'
const sqlFiles = fs.readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort()
const migrationMap = {}
sqlFiles.forEach((f) => {
  migrationMap[f] = fs.readFileSync(path.join(migrationsDir, f), 'utf-8')
})

const newApplyMigrations =
  'function applyMigrations(db) {\n' +
  '  var raw = db.raw;\n' +
  '  raw.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))");\n' +
  '  var appliedRows = raw.prepare("SELECT version FROM schema_migrations").all();\n' +
  '  var applied = new Set(appliedRows.map(function(r) { return r.version; }));\n' +
  '  var files = ' + JSON.stringify(Object.keys(migrationMap)) + ';\n' +
  '  var migrationData = ' + JSON.stringify(migrationMap) + ';\n' +
  '  for (var i = 0; i < files.length; i++) {\n' +
  '    var file = files[i];\n' +
  '    if (applied.has(file)) continue;\n' +
  '    var sql = migrationData[file];\n' +
  '    raw.exec(sql);\n' +
  '    raw.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());\n' +
  '  }\n' +
  '}'

content = content.replace(/function applyMigrations[\s\S]*?^\}/m, newApplyMigrations)

// --- 5. Inline prompt .md files as EMBEDDED_PROMPTS so pkg doesn't need
//          VFS reads for prompt content. src/prompts/loader.ts reads from
//          globalThis.EMBEDDED_PROMPTS at runtime; in dev mode (tsx) it's
//          undefined and we fall back to readFileSync. ---
const promptFiles = ['SOUL.md', 'AGENTS.md', 'tools.md', 'phases.md', 'USER.md.example', 'summarizer-system.md']
const embeddedPrompts = {}
for (const name of promptFiles) {
  try {
    embeddedPrompts[name] = fs.readFileSync(path.join('prompts', name), 'utf-8')
  } catch (e) {
    console.log(`[patch-bundle] WARNING: prompts/${name} not found, skipping`)
  }
}
const embeddedPromptsJson = JSON.stringify(embeddedPrompts)
const embeddedPromptsCode = 'globalThis.EMBEDDED_PROMPTS = ' + embeddedPromptsJson + ';\n'
const firstLine = content.indexOf('\n') + 1
content = content.slice(0, firstLine) + embeddedPromptsCode + content.slice(firstLine)
console.log(
  '[patch-bundle] EMBEDDED_PROMPTS injected (' +
    Object.keys(embeddedPrompts).length +
    ' files)',
)

// --- 6. Inline dist/web/ as WEB_ASSETS so pkg doesn't need VFS for SPA ---
const webAssets = {}
function loadWebDir(dir, base) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    const full = path.join(dir, e.name)
    const rel = '/' + path.relative(base, full).replace(/\\/g, '/')
    if (e.isDirectory()) {
      loadWebDir(full, base)
    } else {
      webAssets[rel] = fs.readFileSync(full).toString('base64')
    }
  }
}
try { loadWebDir('dist/web', 'dist/web') } catch (e) { /* dist/web may not exist */ }
const webAssetsJson = JSON.stringify(webAssets)
const webMime = JSON.stringify({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
})
// Inject WEB_ASSETS at the top of the bundle
const webAssetsCode =
  'var WEB_ASSETS=' + webAssetsJson + ';\n' +
  'var WEB_MIME=' + webMime + ';\n' +
  'function serveWebAsset(path) {\n' +
  '  var b64=WEB_ASSETS[path];\n' +
  '  if(!b64) return null;\n' +
  '  var ext=path.split(".").pop();\n' +
  '  var mime=WEB_MIME["."+ext]||"application/octet-stream";\n' +
  '  return {body:Buffer.from(b64,"base64"),mime:mime};\n' +
  '}\n'
const firstLine2 = content.indexOf('\n') + 1
content = content.slice(0, firstLine2) + webAssetsCode + content.slice(firstLine2)

// Replace the SPA-serving code in server.js to use embedded assets.
// Handles both bundled (c2, import_node_pathN) and non-bundled (c) output.
const assetsOld = content.match(/  app\.get\("\/assets\/\*", \(c\d*\) => \{[\s\S]*?\n  \}\);/)?.[0]
if (assetsOld) {
  content = content.replace(assetsOld, [
    '  app.get("/assets/*", (c) => {',
    '    var assetPath = c.req.path.slice(1);',
    '    var embedded = serveWebAsset("/" + assetPath);',
    '    if (embedded) return c.body(embedded.body, 200, {"Content-Type": embedded.mime});',
    '    var filePath = (0, import_node_path.resolve)(distDir, assetPath);',
    '    if (!filePath.startsWith(distDir)) return c.notFound();',
    '    if (!(0, import_node_fs8.existsSync)(filePath)) return c.notFound();',
    '    var ext = filePath.split(".").pop();',
    '    var mime = { js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png", ico: "image/x-icon", woff2: "font/woff2" };',
    '    return c.body((0, import_node_fs8.readFileSync)(filePath), 200, {"Content-Type": mime[ext ?? ""] ?? "application/octet-stream"});',
    '  });',
  ].join('\n'))
  console.log('[patch-bundle] /assets/* replaced')
} else {
  console.log('[patch-bundle] WARNING: /assets/* pattern not found')
}

const spaOld = content.match(/  app\.get\("\/\*", \(c\d*\) => \{[\s\S]*?\n  \}\);/)?.[0]
if (spaOld) {
  content = content.replace(spaOld, [
    '  app.get("/*", (c) => {',
    '    if (c.req.path.startsWith("/api")) return c.notFound();',
    '    var embeddedIndex = serveWebAsset("/index.html");',
    '    if (embeddedIndex) return c.body(embeddedIndex.body, 200, {"Content-Type": embeddedIndex.mime});',
    '    if (!(0, import_node_fs8.existsSync)(distIndex))',
    '      return c.text("SPA not built. Run `pnpm build` first.", 500);',
    '    return c.html((0, import_node_fs8.readFileSync)(distIndex, "utf-8"));',
    '  });',
  ].join('\n'))
  console.log('[patch-bundle] SPA fallback replaced')
} else {
  console.log('[patch-bundle] WARNING: SPA pattern not found')
}

fs.writeFileSync(BUNDLE, content, 'utf-8')
console.log('[patch-bundle] done (' + Object.keys(webAssets).length + ' web files inlined)')
