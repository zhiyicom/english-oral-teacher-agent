// scripts/patch-bundle.cjs
// v1.0.6 — post-process the esbuild CJS bundle so pkg can consume it.
//
// 1. Replace import.meta.url with CJS __filename equivalent
// 2. Fix PROMPTS_DIR and SUMMARIZER_PROMPT_PATH to use dirname(__filename)
// 3. Inline SQL migration files into applyMigrations()
//
// Run after:  esbuild dist/server.js --format=cjs --outfile=dist/server-bundle.cjs
// Run before: pkg dist/server-bundle.cjs --public --targets node24-win-x64

const fs = require('fs')
const path = require('path')

const BUNDLE = 'dist/server-bundle.cjs'
let content = fs.readFileSync(BUNDLE, 'utf-8')

// --- 1. import.meta.url shim ---
content = content.replace(/var import_meta(\d*) = \{\};/g, (_, n) => {
  return `var import_meta${n} = { url: require("url").pathToFileURL(__filename).href };`
})

// --- 2. PROMPTS_DIR — use dirname(__filename) instead of __dirname ---
content = content.replace(
  /var PROMPTS_DIR = .*?;/,
  'var PROMPTS_DIR = (0, import_node_path3.join)((0, import_node_path3.dirname)(__filename), "prompts");'
)

// --- 3. SUMMARIZER_PROMPT_PATH — same fix ---
content = content.replace(
  /var SUMMARIZER_PROMPT_PATH = \(0, import_node_path\.join\)\(\(0, import_node_path\.dirname\)\(\(0, import_node_url\.fileURLToPath\)\(import_meta\d*\.url\)\), '\.\.', '\.\.', 'prompts'/,
  'var SUMMARIZER_PROMPT_PATH = (0, import_node_path.join)((0, import_node_path.dirname)(__filename), "prompts"'
)

// --- 4. Inline SQL migrations ---
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

fs.writeFileSync(BUNDLE, content, 'utf-8')
console.log('[patch-bundle] done')
