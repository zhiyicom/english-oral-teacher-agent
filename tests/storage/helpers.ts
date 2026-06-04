import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/**
 * Resolve the migrations directory from the test runtime perspective.
 * When tests run via `vitest`, source files are read directly from src/,
 * so migrations live at `<repo>/src/storage/migrations/`.
 */
export function resolveMigrationsDirForTesting(): string {
  return resolve(here, '..', '..', 'src', 'storage', 'migrations')
}
