import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadEnv } from '../../src/config/env.js'

const ORIGINAL_ENV = { ...process.env }

describe('loadEnv', () => {
  beforeEach(() => {
    for (const k of Object.keys(process.env)) {
      if (
        k.startsWith('LLM_') ||
        k.startsWith('APP_') ||
        k === 'API_KEY' ||
        k === 'ANTHROPIC_BASE_URL' ||
        k === 'RUN_LIVE_LLM'
      ) {
        delete process.env[k]
      }
    }
  })

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in ORIGINAL_ENV)) delete process.env[k]
    }
    for (const [k, v] of Object.entries(ORIGINAL_ENV)) {
      process.env[k] = v
    }
  })

  it('throws when API_KEY is missing', () => {
    expect(() => loadEnv()).toThrow(/API_KEY/)
  })

  it('uses default LLM_MODEL_MAIN when not set', () => {
    process.env.API_KEY = 'sk-test'
    const env = loadEnv()
    expect(env.LLM_MODEL_MAIN).toBe('MiniMax-M3')
  })

  it('rejects out-of-range LLM_TEMPERATURE', () => {
    process.env.API_KEY = 'sk-test'
    process.env.LLM_TEMPERATURE = '3.0'
    expect(() => loadEnv()).toThrow(/LLM_TEMPERATURE/)
  })

  it('reads ANTHROPIC_BASE_URL from env when set', () => {
    process.env.API_KEY = 'sk-test'
    process.env.ANTHROPIC_BASE_URL = 'http://localhost:9999'
    const env = loadEnv()
    expect(env.ANTHROPIC_BASE_URL).toBe('http://localhost:9999')
  })
})
