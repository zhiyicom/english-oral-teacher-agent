import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyMigrations, openDb } from '../../src/storage/db.js'
import { resolveMigrationsDirForTesting } from './helpers.js'

// v1.0.5 §C — drift test for the checked-in default topic library.
// Source of truth: data/topics-default.json
// Migration: src/storage/migrations/007_topics_default.sql
// Generator: scripts/export-topics-default.ts (writes both from the same
// in-memory array, so the two are physically guaranteed to be in sync
// at generation time).
//
// This test catches the case where someone hand-edits one file without
// the other, by running all migrations against a temp DB and comparing
// the resulting `topics` table to the JSON file exactly.

interface SeedTopic {
  name: string
  keywords: string[]
  description: string
  createdAt: string
}

const migrationsDir = resolveMigrationsDirForTesting()
let tempDir: string
let seeds: SeedTopic[]

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'topics-default-test-'))
  const jsonPath = join(process.cwd(), 'data', 'topics-default.json')
  const json = readFileSync(jsonPath, 'utf-8')
  seeds = JSON.parse(json) as SeedTopic[]
})

afterEach(() => {
  try {
    rmSync(tempDir, { recursive: true, force: true })
  } catch {
    // best-effort cleanup
  }
})

describe('topics-default seed (v1.0.5 §C)', () => {
  it('JSON file is well-formed and contains 34 topics with all required fields', () => {
    expect(seeds).toHaveLength(34)
    for (const s of seeds) {
      expect(typeof s.name, `seed.name should be a non-empty string`).toBe('string')
      expect(s.name.length).toBeGreaterThan(0)
      expect(Array.isArray(s.keywords), `seed.keywords should be an array`).toBe(true)
      expect(s.keywords.length, `seed.keywords for ${s.name} should not be empty`).toBeGreaterThan(0)
      for (const k of s.keywords) {
        expect(typeof k, `keyword in ${s.name} should be a string`).toBe('string')
        expect(k.length).toBeGreaterThan(0)
      }
      expect(typeof s.description, `seed.description for ${s.name} should be a string`).toBe(
        'string',
      )
      expect(s.description.length).toBeGreaterThan(0)
      expect(typeof s.createdAt, `seed.createdAt for ${s.name} should be ISO string`).toBe('string')
      // ISO 8601 sanity check
      expect(Number.isFinite(Date.parse(s.createdAt))).toBe(true)
    }

    // Names must be unique (PRIMARY KEY constraint in DB)
    const names = seeds.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('migrations 001-007 seed a fresh DB with 30 topics matching JSON exactly', () => {
    const db = openDb({ dataDir: tempDir })
    applyMigrations(db, migrationsDir)

    const rows = db.raw
      .prepare(
        'SELECT name, keywords_json, description, created_at FROM topics ORDER BY name',
      )
      .all() as Array<{
        name: string
        keywords_json: string
        description: string
        created_at: string
      }>
    db.close()

    expect(rows.length).toBe(seeds.length)

    for (const expected of seeds) {
      const actual = rows.find((r) => r.name === expected.name)
      expect(actual, `topic ${expected.name} missing from DB`).toBeDefined()
      expect(actual!.keywords_json).toBe(JSON.stringify(expected.keywords))
      expect(actual!.description).toBe(expected.description)
      expect(actual!.created_at).toBe(expected.createdAt)
    }
  })

  it('applying migrations twice does not duplicate topics (idempotent)', () => {
    const db = openDb({ dataDir: tempDir })
    applyMigrations(db, migrationsDir)
    // Simulate server restart / re-run
    applyMigrations(db, migrationsDir)

    const count = (db.raw.prepare('SELECT COUNT(*) as c FROM topics').get() as { c: number }).c
    db.close()

    expect(count).toBe(34)
  })

  it('applies OR IGNORE correctly when DB already has the same 34 topics', () => {
    const db = openDb({ dataDir: tempDir })
    applyMigrations(db, migrationsDir)

    // User has since edited a topic's description via Web UI. Re-running
    // 007 must not clobber the user's edit (OR IGNORE, not DO UPDATE).
    const editedDesc = 'USER EDITED: 风俗与文化 (B1)'
    db.raw
      .prepare("UPDATE topics SET description = ? WHERE name = 'culture_tradition'")
      .run(editedDesc)

    // Re-run all migrations — 007 should be a no-op due to schema_migrations
    // tracking, but even if it weren't, OR IGNORE would preserve the edit.
    applyMigrations(db, migrationsDir)

    const row = db.raw
      .prepare("SELECT description FROM topics WHERE name = 'culture_tradition'")
      .get() as { description: string }
    db.close()

    expect(row.description).toBe(editedDesc)
  })
})
