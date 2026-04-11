import test from 'node:test'
import assert from 'node:assert/strict'

const { getPickFolderDialogOptions } = await import(
  new URL('./app-dialog-options.ts', import.meta.url).href
).catch(() => ({}) as { getPickFolderDialogOptions?: () => { properties: string[] } })

test('getPickFolderDialogOptions allows creating a new directory from the folder picker', () => {
  assert.equal(typeof getPickFolderDialogOptions, 'function')

  const options = getPickFolderDialogOptions!()

  assert.deepEqual(options.properties, ['openDirectory', 'createDirectory'])
})
