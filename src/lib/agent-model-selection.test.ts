import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveAgentModelId } from './agent-model-selection.ts'

test('resolveAgentModelId keeps an explicitly selected supported Codex model', () => {
  const resolved = resolveAgentModelId(
    'codex',
    'gpt-5.2',
    [{ id: 'gpt-5.4', isDefault: true }, { id: 'gpt-5.2' }],
    'gpt-5-codex',
  )

  assert.equal(resolved, 'gpt-5.2')
})

test('resolveAgentModelId falls back to the live Codex default when no model is set', () => {
  const resolved = resolveAgentModelId(
    'codex',
    null,
    [{ id: 'gpt-5.4', isDefault: true }, { id: 'gpt-5.2' }],
    'gpt-5-codex',
  )

  assert.equal(resolved, 'gpt-5.4')
})

test('resolveAgentModelId prefers the supported Claude fallback when available', () => {
  const resolved = resolveAgentModelId(
    'claude',
    null,
    [{ id: 'claude-opus-4-7' }, { id: 'claude-sonnet-4-6' }],
    'claude-sonnet-4-6',
  )

  assert.equal(resolved, 'claude-sonnet-4-6')
})

test('resolveAgentModelId falls back to the first live Claude model when the baked-in one is gone', () => {
  const resolved = resolveAgentModelId(
    'claude',
    null,
    [{ id: 'claude-sonnet-4-7' }, { id: 'claude-haiku-4-5-20251001' }],
    'claude-sonnet-4-6',
  )

  assert.equal(resolved, 'claude-sonnet-4-7')
})

test('resolveAgentModelId ignores unavailable fallback-only entries when choosing the current model', () => {
  const resolved = resolveAgentModelId(
    'claude',
    null,
    [
      { id: 'claude-opus-4-7', available: false },
      { id: 'claude-sonnet-4-6', available: false },
      { id: 'claude-sonnet-4-7', available: true },
    ],
    'claude-sonnet-4-6',
  )

  assert.equal(resolved, 'claude-sonnet-4-7')
})
