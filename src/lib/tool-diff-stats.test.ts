import test from 'node:test'
import assert from 'node:assert/strict'

import type { AgentSessionMessage } from '../types/index.ts'
import { diffStatsFromMessage, groupDiffsByFile, sumDiffStats } from './tool-diff-stats.ts'

function toolMessage(overrides: Partial<AgentSessionMessage>): AgentSessionMessage {
  return {
    id: 'tool-1',
    role: 'tool',
    title: 'File changes',
    text: '',
    ...overrides,
  }
}

test('diffStatsFromMessage reads Codex unified diff metadata', () => {
  const message = toolMessage({
    metadata: [
      'diff --git a/a.txt b/a.txt',
      'index 1111111..2222222 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@',
      ' one',
      '-two',
      '+two updated',
      '+three',
      'diff --git a/src/b.ts b/src/b.ts',
      'index 3333333..4444444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -3,2 +3,0 @@',
      '-old',
      '-stale',
      '',
    ].join('\n'),
    text: 'update: a.txt\nupdate: src/b.ts',
  })

  assert.deepEqual(diffStatsFromMessage(message), {
    additions: 2,
    deletions: 3,
    changedFiles: 2,
  })
})

test('groupDiffsByFile aggregates per-file counts from Codex unified diffs', () => {
  const files = groupDiffsByFile([
    toolMessage({
      metadata: [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 1111111..2222222 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1,2 @@',
        '-old line',
        '+new line',
        '+another line',
        'diff --git a/docs/readme.md b/docs/readme.md',
        'index 3333333..4444444 100644',
        '--- a/docs/readme.md',
        '+++ b/docs/readme.md',
        '@@ -1,2 +1 @@',
        '-first',
        '-second',
        '+replacement',
        '',
      ].join('\n'),
    }),
  ])

  assert.deepEqual(files, [
    {
      filePath: 'docs/readme.md',
      additions: 1,
      deletions: 2,
      edits: [],
      patches: [
        [
          'diff --git a/docs/readme.md b/docs/readme.md',
          'index 3333333..4444444 100644',
          '--- a/docs/readme.md',
          '+++ b/docs/readme.md',
          '@@ -1,2 +1 @@',
          '-first',
          '-second',
          '+replacement',
        ].join('\n'),
      ],
    },
    {
      filePath: 'src/a.ts',
      additions: 2,
      deletions: 1,
      edits: [],
      patches: [
        [
          'diff --git a/src/a.ts b/src/a.ts',
          'index 1111111..2222222 100644',
          '--- a/src/a.ts',
          '+++ b/src/a.ts',
          '@@ -1 +1,2 @@',
          '-old line',
          '+new line',
          '+another line',
        ].join('\n'),
      ],
    },
  ])
})

test('groupDiffsByFile keeps rename-only file changes visible', () => {
  const files = groupDiffsByFile([
    toolMessage({
      metadata: [
        'diff --git a/src/old.ts b/src/new.ts',
        'similarity index 100%',
        'rename from src/old.ts',
        'rename to src/new.ts',
        '',
      ].join('\n'),
    }),
  ])

  assert.deepEqual(files, [
    {
      filePath: 'src/new.ts',
      additions: 0,
      deletions: 0,
      edits: [],
      patches: [
        [
          'diff --git a/src/old.ts b/src/new.ts',
          'similarity index 100%',
          'rename from src/old.ts',
          'rename to src/new.ts',
        ].join('\n'),
      ],
    },
  ])
})

test('groupDiffsByFile falls back to Codex summary lines when no patch is preserved', () => {
  const files = groupDiffsByFile([
    toolMessage({
      text: 'update: src/app.ts\nadd: src/new.ts\ndelete: src/old.ts',
    }),
  ])

  assert.deepEqual(files, [
    {
      filePath: 'src/app.ts',
      additions: 0,
      deletions: 0,
      edits: [],
    },
    {
      filePath: 'src/new.ts',
      additions: 0,
      deletions: 0,
      edits: [],
    },
    {
      filePath: 'src/old.ts',
      additions: 0,
      deletions: 0,
      edits: [],
    },
  ])
})

test('diffStatsFromMessage falls back to changed-file counts for Codex summaries', () => {
  const stats = diffStatsFromMessage(
    toolMessage({
      text: 'change: src/app.ts\nchange: src/lib/tool-diff-stats.ts',
    }),
  )

  assert.deepEqual(stats, {
    additions: 0,
    deletions: 0,
    changedFiles: 2,
  })
})

test('groupDiffsByFile prefers clean Codex summary text over polluted metadata', () => {
  const files = groupDiffsByFile([
    toolMessage({
      text: 'change: /Users/raj/projects/cells/src/components/agent-session/agent-chat-panel.tsx',
      metadata: [
        'change: /Users/raj/projects/cells/src/components/agent-session/agent-chat-panel.tsxSuccess. Updated the following files:',
        'M /Users/raj/projects/cells/src/components/agent-session/agent-chat-panel.tsx',
      ].join('\n'),
    }),
  ])

  assert.deepEqual(files, [
    {
      filePath: '/Users/raj/projects/cells/src/components/agent-session/agent-chat-panel.tsx',
      additions: 0,
      deletions: 0,
      edits: [],
    },
  ])
})

test('sumDiffStats preserves changed-file counts for Codex summaries', () => {
  const stats = sumDiffStats([
    toolMessage({ text: 'change: src/app.ts\nchange: src/lib/a.ts' }),
    toolMessage({ text: 'change: src/lib/b.ts' }),
  ])

  assert.deepEqual(stats, {
    additions: 0,
    deletions: 0,
    changedFiles: 3,
  })
})
