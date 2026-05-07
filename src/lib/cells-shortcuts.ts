import { hasPrimaryModifier, isMacPlatform } from './keyboard-shortcuts'

export type CellsShortcutCommand =
  | 'toggle-command-palette'
  | 'open-settings'
  | 'toggle-project-switcher'
  | 'toggle-selection-mode'
  | 'close-window'
  | 'restore-last-closed'
  | 'toggle-pin-focused'
  | 'quit-app'
  | 'reload-focused'
  | 'browser-back'
  | 'browser-forward'
  | 'open-browser-location'
  | 'copy-browser-url'
  | 'toggle-title-bar-hidden'
  | 'toggle-title-bar-position'
  | 'zoom-focused-window-in'
  | 'zoom-focused-window-out'
  | 'snap-focused-window'
  | 'zoom-to-fit-focused'
  | 'zoom-to-fit-all'
  | 'snap-left'
  | 'snap-right'
  | 'snap-up'
  | 'snap-down'
  | 'resize-focused-to-fit-viewport'
  | 'resize-window-to-fit-focused'

export interface CellsShortcutPayload {
  command: CellsShortcutCommand
  source: 'browser-view' | 'menu'
  browserId?: string | null
}

export interface ShortcutInput {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
}

export type CellsShortcutScope = 'global' | 'browser' | 'canvas'

interface RendererShortcutContext {
  browserFocused: boolean
  platform?: string
}

function keyMatches(input: ShortcutInput, key: string, code?: string) {
  const normalizedKey = input.key.toLowerCase()
  if (normalizedKey === key) return true
  return Boolean(code && input.code === code)
}

function isZoomInKey(input: ShortcutInput) {
  return (
    keyMatches(input, '+') ||
    keyMatches(input, '=') ||
    keyMatches(input, 'add') ||
    input.code === 'Equal' ||
    input.code === 'NumpadAdd'
  )
}

function isZoomOutKey(input: ShortcutInput) {
  return (
    keyMatches(input, '-') ||
    keyMatches(input, '_') ||
    keyMatches(input, 'subtract') ||
    input.code === 'Minus' ||
    input.code === 'NumpadSubtract'
  )
}

function hasSecondaryControlModifier(input: ShortcutInput, platform?: string) {
  return isMacPlatform(platform) && input.ctrlKey && !input.metaKey && !input.altKey
}

export function matchBrowserViewShortcut(
  input: ShortcutInput,
  platform?: string,
): CellsShortcutCommand | null {
  if (hasSecondaryControlModifier(input, platform)) {
    if (!input.shiftKey && keyMatches(input, 'a', 'KeyA')) return 'toggle-project-switcher'
    if (!input.shiftKey && keyMatches(input, 's', 'KeyS')) return 'toggle-selection-mode'
    return null
  }

  if (input.altKey || !hasPrimaryModifier(input, platform)) return null

  if (input.shiftKey) {
    if (keyMatches(input, 't', 'KeyT')) return 'restore-last-closed'
    if (keyMatches(input, 'p', 'KeyP')) return 'toggle-pin-focused'
    if (keyMatches(input, 'c', 'KeyC')) return 'copy-browser-url'
    if (keyMatches(input, 's', 'KeyS')) return 'toggle-title-bar-position'
    if (keyMatches(input, 'o', 'KeyO')) return 'zoom-to-fit-all'
    if (keyMatches(input, 'enter', 'Enter') || input.code === 'NumpadEnter') {
      return 'resize-focused-to-fit-viewport'
    }
    if (keyMatches(input, '0', 'Digit0') || input.code === 'Numpad0') {
      return 'resize-window-to-fit-focused'
    }
  }

  if (keyMatches(input, 't', 'KeyT')) return 'toggle-command-palette'
  if (keyMatches(input, ',', 'Comma')) return 'open-settings'
  if (keyMatches(input, 'o', 'KeyO')) return 'zoom-to-fit-all'
  if (keyMatches(input, 'w', 'KeyW')) return 'close-window'
  if (keyMatches(input, 'q', 'KeyQ')) return 'quit-app'
  if (keyMatches(input, 'r', 'KeyR')) return 'reload-focused'
  if (keyMatches(input, '[', 'BracketLeft')) return 'browser-back'
  if (keyMatches(input, ']', 'BracketRight')) return 'browser-forward'
  if (keyMatches(input, 'l', 'KeyL')) return 'open-browser-location'
  if (keyMatches(input, 's', 'KeyS')) return 'toggle-title-bar-hidden'
  if (keyMatches(input, 'enter', 'Enter') || input.code === 'NumpadEnter') {
    return 'snap-focused-window'
  }
  if (keyMatches(input, 'arrowleft', 'ArrowLeft')) return 'snap-left'
  if (keyMatches(input, 'arrowright', 'ArrowRight')) return 'snap-right'
  if (keyMatches(input, 'arrowup', 'ArrowUp')) return 'snap-up'
  if (keyMatches(input, 'arrowdown', 'ArrowDown')) return 'snap-down'
  if (keyMatches(input, 'h', 'KeyH')) return 'snap-left'
  if (keyMatches(input, 'j', 'KeyJ')) return 'snap-down'
  if (keyMatches(input, 'k', 'KeyK')) return 'snap-up'
  if (keyMatches(input, '0', 'Digit0') || input.code === 'Numpad0') return 'zoom-to-fit-focused'
  if (isZoomInKey(input)) return 'zoom-focused-window-in'
  if (isZoomOutKey(input)) return 'zoom-focused-window-out'

  return null
}

export function matchRendererShortcut(
  input: ShortcutInput,
  context: RendererShortcutContext,
): CellsShortcutCommand | null {
  const command = matchBrowserViewShortcut(input, context.platform)
  if (command !== 'open-browser-location') return command
  return context.browserFocused ? command : 'snap-right'
}

export function getCellsShortcutScope(command: CellsShortcutCommand): CellsShortcutScope {
  switch (command) {
    case 'reload-focused':
    case 'browser-back':
    case 'browser-forward':
    case 'open-browser-location':
    case 'copy-browser-url':
      return 'browser'
    case 'snap-focused-window':
    case 'zoom-focused-window-in':
    case 'zoom-focused-window-out':
    case 'zoom-to-fit-focused':
    case 'zoom-to-fit-all':
    case 'snap-left':
    case 'snap-right':
    case 'snap-up':
    case 'snap-down':
    case 'resize-focused-to-fit-viewport':
    case 'resize-window-to-fit-focused':
      return 'canvas'
    default:
      return 'global'
  }
}

export function shouldFocusRendererForShortcut(command: CellsShortcutCommand) {
  return command === 'open-browser-location' || getCellsShortcutScope(command) !== 'browser'
}

export const CELLS_SHORTCUT_EVENT = 'cells:shortcut'
export const CELLS_TOGGLE_COMMAND_PALETTE_EVENT = 'cells:toggle-command-palette'
export const CELLS_OPEN_SETTINGS_EVENT = 'cells:open-settings'
export const CELLS_TOGGLE_PROJECT_SWITCHER_EVENT = 'cells:toggle-project-switcher'
export const CELLS_OPEN_BROWSER_LOCATION_EVENT = 'cells:open-browser-location'
export const CELLS_COPY_BROWSER_URL_EVENT = 'cells:copy-browser-url'
export const CELLS_SHORTCUT_STATE_RESET_EVENT = 'cells:shortcut-state-reset'
