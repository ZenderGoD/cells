import test from 'node:test'
import assert from 'node:assert/strict'

import type { AgentSessionMessage } from '../types/index.ts'
import {
  computeEditWriteDiffStats,
  diffStatsFromMessage,
  groupDiffsByFile,
  sumDiffStats,
} from './tool-diff-stats.ts'

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
    toolMessage({ id: 't1-a', text: 'change: src/app.ts\nchange: src/lib/a.ts' }),
    toolMessage({ id: 't2-b', text: 'change: src/lib/b.ts' }),
  ])

  assert.deepEqual(stats, {
    additions: 0,
    deletions: 0,
    changedFiles: 3,
  })
})

test('computeEditWriteDiffStats counts only changed lines for Edit (LCS, ignores context)', () => {
  // 5-line context with a single line changed in the middle. Old behavior
  // counted both strings whole (+5/-5); LCS-based behavior should only see
  // the one diverging line as +1/-1.
  const stats = computeEditWriteDiffStats('Edit', {
    file_path: '/abs/foo.ts',
    old_string: 'line a\nline b\nline c\nline d\nline e',
    new_string: 'line a\nline b\nLINE C\nline d\nline e',
  })
  assert.deepEqual(stats, { additions: 1, deletions: 1 })
})

test('computeEditWriteDiffStats sums LCS counts across MultiEdit edits', () => {
  const stats = computeEditWriteDiffStats('MultiEdit', {
    file_path: '/abs/foo.ts',
    edits: [
      { old_string: 'one\ntwo\nthree', new_string: 'one\nTWO\nthree' },
      { old_string: 'aa\nbb', new_string: 'aa\nBB\ncc' },
    ],
  })
  // Edit 1: 1 line replaced. Edit 2: 1 line replaced + 1 line added.
  assert.deepEqual(stats, { additions: 3, deletions: 2 })
})

test('groupDiffsByFile uses LCS-based counts for Claude Edit', () => {
  const files = groupDiffsByFile([
    {
      id: 'tool-edit-1',
      role: 'tool',
      title: 'Edit',
      text: '',
      metadata: JSON.stringify({
        file_path: '/abs/src/foo.ts',
        old_string: 'line a\nline b\nline c\nline d\nline e',
        new_string: 'line a\nline b\nLINE C\nline d\nline e',
      }),
    },
  ])
  assert.equal(files.length, 1)
  assert.equal(files[0].additions, 1)
  assert.equal(files[0].deletions, 1)
})

test('sumDiffStats dedupes Codex File-changes within the same turn', () => {
  // Same turn (`t3-`), two `File changes` items: the second carries the
  // cumulative-for-turn diff (which already subsumes the first's changes).
  // Naive summing would count file `a.txt` twice. Dedup keeps only the
  // latest message per turn.
  const earlier = toolMessage({
    id: 't3-fileChange-1',
    updatedAt: 1000,
    metadata: [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1,2 @@',
      ' one',
      '+two',
      '',
    ].join('\n'),
  })
  const latest = toolMessage({
    id: 't3-fileChange-2',
    updatedAt: 2000,
    metadata: [
      'diff --git a/a.txt b/a.txt',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1,2 @@',
      ' one',
      '+two',
      'diff --git a/b.txt b/b.txt',
      '--- a/b.txt',
      '+++ b/b.txt',
      '@@ -1 +1,2 @@',
      ' x',
      '+y',
      '',
    ].join('\n'),
  })

  assert.deepEqual(sumDiffStats([earlier, latest]), {
    additions: 2,
    deletions: 0,
    changedFiles: 2,
  })

  // Across turns the diffs are independent per-turn deltas, so they should
  // still sum normally.
  const turn4 = toolMessage({
    id: 't4-fileChange-1',
    updatedAt: 3000,
    metadata: [
      'diff --git a/c.txt b/c.txt',
      '--- a/c.txt',
      '+++ b/c.txt',
      '@@ -1 +1,2 @@',
      ' z',
      '+w',
      '',
    ].join('\n'),
  })
  assert.deepEqual(sumDiffStats([earlier, latest, turn4]), {
    additions: 3,
    deletions: 0,
    changedFiles: 3,
  })
})

test('groupDiffsByFile dedupes Codex File-changes within the same turn', () => {
  const earlier = toolMessage({
    id: 't1-fileChange-1',
    updatedAt: 1000,
    metadata: [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1 +1,2 @@',
      ' a',
      '+b',
      '',
    ].join('\n'),
  })
  const latest = toolMessage({
    id: 't1-fileChange-2',
    updatedAt: 2000,
    metadata: [
      'diff --git a/foo.ts b/foo.ts',
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1 +1,3 @@',
      ' a',
      '+b',
      '+c',
      '',
    ].join('\n'),
  })

  const files = groupDiffsByFile([earlier, latest])
  assert.equal(files.length, 1)
  assert.equal(files[0].filePath, 'foo.ts')
  assert.equal(files[0].additions, 2)
  assert.equal(files[0].deletions, 0)
})
