import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_OPUS_4_7_MODEL_ID,
  CLAUDE_SONNET_4_6_MODEL_ID,
  compareCliVersions,
  normalizeClaudeCatalogModelId,
  parseGenericCliVersion,
  supportsClaudeOpus47,
} from './claude-model-catalog.ts'

test('parseGenericCliVersion extracts Claude CLI versions', () => {
  assert.equal(parseGenericCliVersion('2.1.114 (Claude Code)'), '2.1.114')
  assert.equal(parseGenericCliVersion('claude 2.1.111-beta.1'), '2.1.111-beta.1')
  assert.equal(parseGenericCliVersion('no version here'), null)
})

test('supportsClaudeOpus47 uses semver-style version comparison', () => {
  assert.equal(supportsClaudeOpus47('2.1.110'), false)
  assert.equal(supportsClaudeOpus47('2.1.111'), true)
  assert.equal(supportsClaudeOpus47('2.1.114'), true)
  assert.equal(compareCliVersions('2.1.111-beta.1', '2.1.111') < 0, true)
})

test('normalizeClaudeCatalogModelId maps the default alias back to Opus 4.7', () => {
  assert.equal(
    normalizeClaudeCatalogModelId(
      {
        id: 'default',
        displayName: 'Default (recommended)',
        description: 'Opus 4.7 with 1M context · Most capable for complex work',
      },
      '2.1.114',
    ),
    CLAUDE_OPUS_4_7_MODEL_ID,
  )
})

test('normalizeClaudeCatalogModelId maps sonnet and haiku aliases to the concrete ids Cells uses', () => {
  assert.equal(
    normalizeClaudeCatalogModelId(
      {
        id: 'sonnet',
        displayName: 'Sonnet',
        description: 'Sonnet 4.6 · Best for everyday tasks',
      },
      '2.1.114',
    ),
    CLAUDE_SONNET_4_6_MODEL_ID,
  )
  assert.equal(
    normalizeClaudeCatalogModelId(
      {
        id: 'haiku',
        displayName: 'Haiku',
        description: 'Haiku 4.5 · Fastest for quick answers',
      },
      '2.1.114',
    ),
    CLAUDE_HAIKU_4_5_MODEL_ID,
  )
})

test('normalizeClaudeCatalogModelId preserves the distinct Sonnet 1M alias', () => {
  assert.equal(
    normalizeClaudeCatalogModelId(
      {
        id: 'sonnet[1m]',
        displayName: 'Sonnet (1M context)',
        description: 'Sonnet 4.6 with 1M context · Billed as extra usage',
      },
      '2.1.114',
    ),
    'sonnet[1m]',
  )
})
