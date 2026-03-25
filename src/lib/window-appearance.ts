import type { CSSProperties } from 'react'

export interface WindowAppearanceSettings {
  windowOpacity: number
}

export const DEFAULT_WINDOW_APPEARANCE: WindowAppearanceSettings = {
  windowOpacity: 82,
}

const SHELL_SURFACE_OPACITY = 0.82
const CANVAS_SURFACE_OPACITY = 0.33
const CANVAS_GRID_OPACITY = 0.25

const MIN_WINDOW_OPACITY = 0
const MAX_WINDOW_OPACITY = 100

export function normalizeWindowAppearance(
  value: Partial<WindowAppearanceSettings> | null | undefined,
): WindowAppearanceSettings {
  return {
    windowOpacity: clamp(
      value?.windowOpacity ?? DEFAULT_WINDOW_APPEARANCE.windowOpacity,
      MIN_WINDOW_OPACITY,
      MAX_WINDOW_OPACITY,
    ),
  }
}

export function buildWindowAppearanceStyle(
  value: WindowAppearanceSettings,
): CSSProperties &
  Record<
    '--window-surface-opacity' | '--canvas-surface-opacity' | '--canvas-grid-opacity',
    string
  > {
  const normalized = normalizeWindowAppearance(value)
  const opacityFactor = normalized.windowOpacity / 100

  return {
    '--window-surface-opacity': roundAlpha(SHELL_SURFACE_OPACITY * opacityFactor),
    '--canvas-surface-opacity': roundAlpha(CANVAS_SURFACE_OPACITY * opacityFactor),
    '--canvas-grid-opacity': roundAlpha(CANVAS_GRID_OPACITY * opacityFactor),
  }
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function roundAlpha(value: number) {
  return String(Math.round(value * 100) / 100)
}
