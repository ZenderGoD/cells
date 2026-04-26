import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'

const bundled = await build({
  entryPoints: [new URL('./cells-shortcuts.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})
const { matchRendererShortcut } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
)

test('Cmd+Shift+Enter resizes the focused window to the viewport on macOS', () => {
  assert.equal(
    matchRendererShortcut(
      {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        ctrlKey: false,
        shiftKey: true,
        altKey: false,
      },
      { browserFocused: false, platform: 'MacIntel' },
    ),
    'resize-focused-to-fit-viewport',
  )
})

test('Cmd+Option+Enter is left for the agent composer branch shortcut', () => {
  assert.equal(
    matchRendererShortcut(
      {
        key: 'Enter',
        code: 'Enter',
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: true,
      },
      { browserFocused: false, platform: 'MacIntel' },
    ),
    null,
  )
})
