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

function isZoomInKey(input: ShortcutInput) {
  const key = input.key.toLowerCase()
  return (
    key === '+' ||
    key === '=' ||
    key === 'add' ||
    input.code === 'Equal' ||
    input.code === 'NumpadAdd'
  )
}

function isZoomOutKey(input: ShortcutInput) {
  const key = input.key.toLowerCase()
  return (
    key === '-' ||
    key === '_' ||
    key === 'subtract' ||
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
  const key = input.key.toLowerCase()

  if (hasSecondaryControlModifier(input, platform)) {
    if (!input.shiftKey && key === 'a') return 'toggle-project-switcher'
    if (!input.shiftKey && key === 's') return 'toggle-selection-mode'
    return null
  }

  if (input.altKey || !hasPrimaryModifier(input, platform)) return null

  if (input.shiftKey) {
    if (key === 't') return 'restore-last-closed'
    if (key === 'p') return 'toggle-pin-focused'
    if (key === 'c') return 'copy-browser-url'
    if (key === 's') return 'toggle-title-bar-position'
    if (key === 'o') return 'zoom-to-fit-all'
    if (key === 'enter') return 'resize-focused-to-fit-viewport'
    if (key === '0') return 'resize-window-to-fit-focused'
  }

  if (key === 't') return 'toggle-command-palette'
  if (key === ',') return 'open-settings'
  if (key === 'o') return 'zoom-to-fit-all'
  if (key === 'w') return 'close-window'
  if (key === 'q') return 'quit-app'
  if (key === 'r') return 'reload-focused'
  if (key === '[') return 'browser-back'
  if (key === ']') return 'browser-forward'
  if (key === 'l') return 'open-browser-location'
  if (key === 's') return 'toggle-title-bar-hidden'
  if (key === 'enter') return 'snap-focused-window'
  if (key === 'arrowleft') return 'snap-left'
  if (key === 'arrowright') return 'snap-right'
  if (key === 'arrowup') return 'snap-up'
  if (key === 'arrowdown') return 'snap-down'
  if (key === 'h') return 'snap-left'
  if (key === 'j') return 'snap-down'
  if (key === 'k') return 'snap-up'
  if (key === '0') return 'zoom-to-fit-focused'
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
