import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  isAutoExpandTopicsEnabled,
  loadPreferences,
  savePreferences,
} from '../../src/config/preferences.js'

describe('config/preferences (v1.1.0 §1.1)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prefs-test-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('loadPreferences: empty dir → returns {}', () => {
    expect(loadPreferences(dir)).toEqual({})
  })

  it('savePreferences then loadPreferences round-trip', () => {
    savePreferences(dir, { font_size: 18, show_debug: true })
    const loaded = loadPreferences(dir)
    expect(loaded.font_size).toBe(18)
    expect(loaded.show_debug).toBe(true)
  })

  it('savePreferences merges into existing file', () => {
    savePreferences(dir, { font_size: 18 })
    savePreferences(dir, { show_debug: true })
    const loaded = loadPreferences(dir)
    expect(loaded.font_size).toBe(18)
    expect(loaded.show_debug).toBe(true)
  })

  it('isAutoExpandTopicsEnabled: defaults to false when key absent', () => {
    savePreferences(dir, { font_size: 14 })
    expect(isAutoExpandTopicsEnabled(dir)).toBe(false)
  })

  it('isAutoExpandTopicsEnabled: returns true after opt-in', () => {
    savePreferences(dir, { auto_expand_topics: true })
    expect(isAutoExpandTopicsEnabled(dir)).toBe(true)
  })

  it('isAutoExpandTopicsEnabled: requires strict true (no truthy coercion)', () => {
    savePreferences(dir, { auto_expand_topics: 'yes' as unknown as boolean })
    expect(isAutoExpandTopicsEnabled(dir)).toBe(false)
  })

  it('file is created on first save', () => {
    const path = join(dir, 'preferences.json')
    expect(existsSync(path)).toBe(false)
    savePreferences(dir, { font_size: 16 })
    expect(existsSync(path)).toBe(true)
  })
})
