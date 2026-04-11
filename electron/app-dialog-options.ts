import type { OpenDialogOptions } from 'electron'

export function getPickFolderDialogOptions(): OpenDialogOptions {
  return {
    properties: ['openDirectory', 'createDirectory'],
  }
}
