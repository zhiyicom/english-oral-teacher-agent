// src/config/preferences.ts
// v1.0.1 — UI preferences stored in a JSON file (localStorage is not
// reliable across browser restarts). Voice settings stay in USER.md.
// v1.1.0 §1.1 — extracted from server.ts so CLI can read the same
// preferences file (auto_expand_topics toggle).

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

export interface Preferences {
  font_size?: number
  show_debug?: boolean
  mic_hotkey?: Record<string, unknown>
  send_hotkey?: Record<string, unknown>
  /** v1.1.0 §1.1 — auto-expand topic library at session end. */
  auto_expand_topics?: boolean
  [key: string]: unknown
}

function prefsPathFor(dataDir: string): string {
  return resolve(dataDir, 'preferences.json')
}

export function loadPreferences(dataDir: string): Preferences {
  const path = prefsPathFor(dataDir)
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8')) as Preferences
    }
  } catch {
    /* ignore — missing or corrupt file → empty prefs */
  }
  return {}
}

export function savePreferences(dataDir: string, updates: Preferences): void {
  const path = prefsPathFor(dataDir)
  const current = loadPreferences(dataDir)
  const merged: Preferences = { ...current, ...updates }
  writeFileSync(path, JSON.stringify(merged), 'utf-8')
}

/** v1.1.0 §1.1 — typed accessor; defaults to false. */
export function isAutoExpandTopicsEnabled(dataDir: string): boolean {
  return loadPreferences(dataDir).auto_expand_topics === true
}
