import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

export interface DbOptions {
  dataDir: string
  dbFilename?: string
}

export interface DbHandle {
  raw: Database.Database
  path: string
  close(): void
  integrityCheck(): 'ok' | string
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, 'migrations')

// v1.0.6 — resolve better-sqlite3 native binding path for Bun compile.
// In the compiled binary, bindings' directory walk fails because the VFS
// doesn't mirror the project tree. We compute the path at module init so
// the .node file is found by Bun's require at runtime.
function resolveNativeBinding(): string | undefined {
  try {
    // In Bun compile, the .node is bundled. require.resolve finds it.
    return require.resolve('better-sqlite3/build/Release/better_sqlite3.node')
  } catch {
    return undefined
  }
}

export function openDb(opts: DbOptions): DbHandle {
  if (!existsSync(opts.dataDir)) {
    mkdirSync(opts.dataDir, { recursive: true })
  }
  const filename = opts.dbFilename ?? 'oral-teacher.db'
  const dbPath = join(opts.dataDir, filename)
  const nativeBinding = resolveNativeBinding()
  const raw = nativeBinding
    ? new Database(dbPath, { nativeBinding })
    : new Database(dbPath)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  return {
    raw,
    path: dbPath,
    close: () => raw.close(),
    integrityCheck: () => {
      const row = raw.prepare('PRAGMA integrity_check').get() as { integrity_check: string }
      return row.integrity_check
    },
  }
}

export function applyMigrations(
  handle: DbHandle,
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR,
): void {
  const { raw } = handle
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `)

  const appliedRows = raw.prepare('SELECT version FROM schema_migrations').all() as {
    version: string
  }[]
  const applied = new Set(appliedRows.map((r) => r.version))

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort()

  for (const file of files) {
    const version = file.replace(/\.sql$/, '')
    if (applied.has(version)) continue
    const sql = readFileSync(join(migrationsDir, file), 'utf8')
    const tx = raw.transaction(() => {
      raw.exec(sql)
      raw
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, new Date().toISOString())
    })
    tx()
  }
}
